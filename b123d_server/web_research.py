"""
Server-side web-research proxy — lets the AI assistant search the web and read
pages it finds.

The Svelte studio runs in a browser, where same-origin / CORS rules block
fetching arbitrary third-party pages from JavaScript. So the assistant cannot
search or scrape directly. This blueprint proxies those two operations through
the Flask kernel, which has no CORS constraints:

  POST /ai/web_search  { query, limit? }
    → { ok: true,  results: [ { title, url, snippet } ] }
    → { ok: false, error: "<message>", results: [] }   (never 500)

  POST /ai/web_fetch   { url, maxChars? }
    → { ok: true,  url, title, text, truncated }
    → { ok: false, error: "<message>" }                (never 500)

Search source: DuckDuckGo's no-API-key HTML endpoint
(https://html.duckduckgo.com/html/). Results are parsed with the stdlib
html.parser — no scraping deps are added. DuckDuckGo wraps result links in a
redirect (…/l/?uddg=<urlencoded real url>); we decode those back to the real
target.

Security: /ai/web_fetch is an SSRF risk — a caller could ask the kernel to
fetch http://169.254.169.254/ (cloud metadata) or an internal service. So we
resolve the target host and reject any address in a private / loopback /
link-local / reserved range, and we only allow http(s). Every network call has
a timeout and a response-size cap.

Abuse: both routes are rate-limited in-process (a simple per-process token /
sliding-window counter) since they are intentionally left ungated (no auth) so
the assistant can use them without a user session.

Transport: Python stdlib only (urllib + html.parser). `requests` is available
in this server, but urllib gives the per-connection control needed to enforce
the SSRF host check and to intercept redirects, so we use it here.
"""

import ipaddress
import re
import socket
import threading
import time
from html.parser import HTMLParser
from urllib.parse import parse_qs, quote_plus, urlparse, urljoin, unquote
from urllib.request import Request, build_opener, HTTPRedirectHandler

from flask import Blueprint, jsonify, request

web_research_bp = Blueprint("web_research", __name__)

# A normal-looking desktop User-Agent. DuckDuckGo's HTML endpoint and most
# sites serve a usable page to a recognizable browser UA and may block obvious
# bot/empty UAs.
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 "
    "ParaformStudio/1.0 (+web-research)"
)

_DDG_HTML_URL = "https://html.duckduckgo.com/html/"

_SEARCH_TIMEOUT_S = 8
_FETCH_TIMEOUT_S = 8

# Hard caps. maxChars is per-request-tunable up to this; response bytes are
# capped regardless so a huge page can't blow up memory.
_MAX_RESULTS = 10
_DEFAULT_RESULTS = 5
_DEFAULT_MAX_CHARS = 6000
_HARD_MAX_CHARS = 20000
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024  # 2 MB

# In-process rate limit: sliding window per route. Generous enough for an
# assistant's tool loop, low enough to blunt a runaway / abusive client.
_RATE_WINDOW_S = 60.0
_RATE_MAX_SEARCH = 30   # searches / minute / process
_RATE_MAX_FETCH = 60    # fetches  / minute / process

_rate_lock = threading.Lock()
_rate_hits: dict = {}   # bucket-name -> [monotonic timestamps]


def _rate_ok(bucket: str, limit: int) -> bool:
    """Sliding-window limiter. True if this call is within `limit` per window."""
    now = time.monotonic()
    cutoff = now - _RATE_WINDOW_S
    with _rate_lock:
        hits = _rate_hits.get(bucket)
        if hits is None:
            hits = []
            _rate_hits[bucket] = hits
        # Drop timestamps older than the window.
        i = 0
        for ts in hits:
            if ts > cutoff:
                break
            i += 1
        if i:
            del hits[:i]
        if len(hits) >= limit:
            return False
        hits.append(now)
        return True


# ── SSRF guard ────────────────────────────────────────────────────────────────

def _ip_is_blocked(ip_str: str) -> bool:
    """True if an IP literal is loopback / private / link-local / reserved."""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        # Not an IP literal — caller resolves the hostname instead.
        return True
    return (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def _host_is_blocked(host: str) -> bool:
    """Resolve `host` and block if it (or any resolved address) is non-public.

    Covers the explicit ranges called out in the spec — localhost, 127/8, ::1,
    169.254/16 (link-local, incl. cloud metadata 169.254.169.254), 10/8,
    192.168/16, 172.16–31/12 — plus the rest of the private/reserved space,
    via Python's ipaddress classification. A hostname that resolves to *any*
    blocked address is rejected (defends against DNS-rebinding to an internal
    IP). Resolution failure also blocks.
    """
    if not host:
        return True
    host = host.strip().strip(".").lower()
    if not host:
        return True

    # Obvious localhost aliases, before any DNS.
    if host in ("localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"):
        return True

    # Bracketed IPv6 literal: [::1] → ::1
    literal = host
    if literal.startswith("[") and literal.endswith("]"):
        literal = literal[1:-1]

    # If the host is itself an IP literal, classify it directly.
    try:
        ipaddress.ip_address(literal)
        return _ip_is_blocked(literal)
    except ValueError:
        pass

    # Hostname → resolve every address it maps to; block if any is non-public.
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, socket.herror, UnicodeError, OSError):
        return True
    if not infos:
        return True
    for info in infos:
        sockaddr = info[4]
        ip_str = sockaddr[0] if sockaddr else None
        if not ip_str:
            return True
        # Strip a scope id if present (fe80::1%eth0).
        ip_str = ip_str.split("%", 1)[0]
        if _ip_is_blocked(ip_str):
            return True
    return False


class _GuardedRedirectHandler(HTTPRedirectHandler):
    """Re-run the SSRF host check on every redirect Location.

    Without this, a public URL could 302 to http://169.254.169.254/ and the
    default handler would happily follow it. We validate the scheme + host of
    each redirect target before allowing urllib to follow it.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urlparse(newurl)
        if parsed.scheme not in ("http", "https"):
            return None
        if _host_is_blocked(parsed.hostname or ""):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(url: str, timeout: int, *, data: bytes | None = None,
          accept: str = "text/html,application/xhtml+xml"):
    """Open `url` with the guarded opener. Returns an http.client response.

    Raises on any error (caller catches). The SSRF check must already have
    passed for the initial host; redirects are re-checked by the handler.
    """
    headers = {
        "User-Agent": _USER_AGENT,
        "Accept": accept,
        "Accept-Language": "en-US,en;q=0.9",
    }
    method = "POST" if data is not None else "GET"
    req = Request(url, data=data, headers=headers, method=method)
    opener = build_opener(_GuardedRedirectHandler())
    return opener.open(req, timeout=timeout)


def _read_capped(resp, cap: int) -> bytes:
    """Read at most `cap` bytes from a response stream."""
    return resp.read(cap + 1)[:cap]


def _decode_body(raw: bytes, resp) -> str:
    """Best-effort decode of an HTTP body to str using the declared charset."""
    charset = None
    try:
        charset = resp.headers.get_content_charset()
    except Exception:
        charset = None
    for enc in (charset, "utf-8", "latin-1"):
        if not enc:
            continue
        try:
            return raw.decode(enc, errors="replace")
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", errors="replace")


# ── DuckDuckGo HTML parsing ────────────────────────────────────────────────────

def _decode_ddg_href(href: str) -> str:
    """DuckDuckGo wraps results as /l/?uddg=<encoded real url>. Unwrap it.

    Handles protocol-relative (//duckduckgo.com/l/?…) and absolute forms, and
    passes through hrefs that aren't redirect wrappers.
    """
    if not href:
        return ""
    candidate = href
    if candidate.startswith("//"):
        candidate = "https:" + candidate
    try:
        parsed = urlparse(candidate)
    except ValueError:
        return href
    if "/l/" in (parsed.path or "") or parsed.path.endswith("/l"):
        qs = parse_qs(parsed.query or "")
        target = qs.get("uddg", [None])[0]
        if target:
            return unquote(target)
    # Non-wrapper href: if it's protocol-relative, normalize to https.
    if href.startswith("//"):
        return "https:" + href
    return href


class _DDGResultParser(HTMLParser):
    """Pull (title, url, snippet) triples out of DuckDuckGo HTML results.

    DuckDuckGo's HTML layout uses:
      a.result__a            → result title + link (href is the /l/?uddg= wrapper)
      a.result__snippet  or
      div.result__snippet    → result snippet text

    We track which class is "active" and accumulate text into the matching
    field. Robust to extra wrapper tags; tolerant of layout drift (anything we
    don't recognize is ignored).
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results: list = []
        self._cur: dict | None = None
        self._mode: str | None = None  # 'title' | 'snippet' | None
        self._depth = 0

    @staticmethod
    def _classes(attrs) -> set:
        for k, v in attrs:
            if k == "class" and v:
                return set(v.split())
        return set()

    @staticmethod
    def _attr(attrs, name):
        for k, v in attrs:
            if k == name:
                return v
        return None

    def handle_starttag(self, tag, attrs):
        classes = self._classes(attrs)
        if tag == "a" and "result__a" in classes:
            # Start a new result row keyed off the title anchor.
            href = self._attr(attrs, "href") or ""
            self._cur = {"title": "", "url": _decode_ddg_href(href), "snippet": ""}
            self.results.append(self._cur)
            self._mode = "title"
            self._depth = 1
            return
        if "result__snippet" in classes:
            if self._cur is None:
                self._cur = {"title": "", "url": "", "snippet": ""}
                self.results.append(self._cur)
            self._mode = "snippet"
            self._depth = 1
            return
        # Track nesting depth while we're capturing text inside a field.
        if self._mode is not None:
            self._depth += 1

    def handle_endtag(self, tag):
        if self._mode is not None:
            self._depth -= 1
            if self._depth <= 0:
                self._mode = None
                self._depth = 0

    def handle_data(self, data):
        if self._mode is None or self._cur is None or not data:
            return
        if self._mode == "title":
            self._cur["title"] += data
        elif self._mode == "snippet":
            self._cur["snippet"] += data


_WS_RE = re.compile(r"\s+")


def _clean(text: str) -> str:
    return _WS_RE.sub(" ", (text or "")).strip()


def _parse_ddg_results(html: str, limit: int) -> list:
    parser = _DDGResultParser()
    try:
        parser.feed(html)
    except Exception:
        # html.parser is lenient, but never let a parse blow up the request.
        pass
    out: list = []
    seen = set()
    for r in parser.results:
        url = _clean(r.get("url"))
        title = _clean(r.get("title"))
        snippet = _clean(r.get("snippet"))
        if not url or not url.lower().startswith(("http://", "https://")):
            continue
        if url in seen:
            continue
        seen.add(url)
        out.append({"title": title, "url": url, "snippet": snippet})
        if len(out) >= limit:
            break
    return out


# ── HTML → readable text ────────────────────────────────────────────────────────

class _TextExtractor(HTMLParser):
    """Strip <script>/<style>/<head-noise>, grab <title>, collect body text.

    Block-level tags emit a newline so paragraphs don't run together; the
    caller collapses runs of whitespace afterwards.
    """

    _SKIP = {"script", "style", "noscript", "template", "svg", "head"}
    _BLOCK = {
        "p", "div", "br", "li", "ul", "ol", "tr", "table", "section",
        "article", "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
        "blockquote", "pre", "hr", "nav", "aside", "main",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title_parts: list = []
        self.text_parts: list = []
        self._skip_depth = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip_depth += 1
            return
        if tag == "title":
            self._in_title = True
            return
        if tag in self._BLOCK and self._skip_depth == 0:
            self.text_parts.append("\n")

    def handle_startendtag(self, tag, attrs):
        if tag in self._BLOCK and self._skip_depth == 0:
            self.text_parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip_depth > 0:
            self._skip_depth -= 1
            return
        if tag == "title":
            self._in_title = False
            return
        if tag in self._BLOCK and self._skip_depth == 0:
            self.text_parts.append("\n")

    def handle_data(self, data):
        if not data:
            return
        if self._in_title:
            self.title_parts.append(data)
            return
        if self._skip_depth == 0:
            self.text_parts.append(data)


_MULTINEWLINE_RE = re.compile(r"\n[ \t]*\n+")
_INLINE_WS_RE = re.compile(r"[ \t\f\v]+")


def _extract_text(html: str):
    """Return (title, collapsed_text) from an HTML document."""
    parser = _TextExtractor()
    try:
        parser.feed(html)
    except Exception:
        pass
    title = _clean("".join(parser.title_parts))
    raw = "".join(parser.text_parts)
    # Collapse inline whitespace, then squeeze blank-line runs to a single
    # newline so the text stays readable but compact.
    raw = _INLINE_WS_RE.sub(" ", raw)
    raw = _MULTINEWLINE_RE.sub("\n", raw)
    lines = [ln.strip() for ln in raw.split("\n")]
    text = "\n".join(ln for ln in lines if ln)
    return title, text


# ── Routes ──────────────────────────────────────────────────────────────────────

@web_research_bp.route("/ai/web_search", methods=["POST"])
def web_search():
    """Search the web via DuckDuckGo's HTML endpoint. Never raises; never 500s."""
    try:
        if not _rate_ok("search", _RATE_MAX_SEARCH):
            return jsonify({
                "ok": False,
                "error": "rate limit: too many searches, slow down",
                "results": [],
            })

        data = request.get_json(force=True, silent=True) or {}
        query = (data.get("query") or "").strip()
        if not query:
            return jsonify({"ok": False, "error": "empty query", "results": []})

        try:
            limit = int(data.get("limit", _DEFAULT_RESULTS))
        except (TypeError, ValueError):
            limit = _DEFAULT_RESULTS
        limit = max(1, min(_MAX_RESULTS, limit))

        # POST the query to DDG's HTML endpoint (its GET form also works, but
        # POST avoids some bot heuristics). Body is x-www-form-urlencoded.
        body = ("q=" + quote_plus(query)).encode("utf-8")
        try:
            resp = _open(
                _DDG_HTML_URL,
                _SEARCH_TIMEOUT_S,
                data=body,
                accept="text/html,application/xhtml+xml",
            )
        except Exception as e:
            return jsonify({
                "ok": False,
                "error": f"search request failed: {e}",
                "results": [],
            })

        try:
            raw = _read_capped(resp, _MAX_RESPONSE_BYTES)
            html = _decode_body(raw, resp)
        finally:
            try:
                resp.close()
            except Exception:
                pass

        results = _parse_ddg_results(html, limit)
        return jsonify({"ok": True, "results": results})
    except Exception as e:
        # Absolute backstop — this route promises to never 500.
        return jsonify({"ok": False, "error": f"unexpected: {e}", "results": []})


@web_research_bp.route("/ai/web_fetch", methods=["POST"])
def web_fetch():
    """Fetch a URL server-side and return its readable text. Never 500s."""
    try:
        if not _rate_ok("fetch", _RATE_MAX_FETCH):
            return jsonify({
                "ok": False,
                "error": "rate limit: too many fetches, slow down",
            })

        data = request.get_json(force=True, silent=True) or {}
        url = (data.get("url") or "").strip()
        if not url:
            return jsonify({"ok": False, "error": "empty url"})

        try:
            max_chars = int(data.get("maxChars", _DEFAULT_MAX_CHARS))
        except (TypeError, ValueError):
            max_chars = _DEFAULT_MAX_CHARS
        max_chars = max(1, min(_HARD_MAX_CHARS, max_chars))

        try:
            parsed = urlparse(url)
        except ValueError:
            return jsonify({"ok": False, "error": "invalid url"})

        if parsed.scheme not in ("http", "https"):
            return jsonify({"ok": False, "error": "blocked host"})

        host = parsed.hostname or ""
        if _host_is_blocked(host):
            return jsonify({"ok": False, "error": "blocked host"})

        try:
            resp = _open(url, _FETCH_TIMEOUT_S, accept="text/html,application/xhtml+xml,text/plain")
        except Exception as e:
            return jsonify({"ok": False, "error": f"fetch failed: {e}"})

        try:
            # Defense in depth: re-check the FINAL URL after redirects, in case
            # a handler edge case let one through.
            final_url = url
            try:
                final_url = resp.geturl() or url
            except Exception:
                final_url = url
            fparsed = urlparse(final_url)
            if fparsed.scheme not in ("http", "https") or _host_is_blocked(fparsed.hostname or ""):
                return jsonify({"ok": False, "error": "blocked host"})

            raw = _read_capped(resp, _MAX_RESPONSE_BYTES)
            html = _decode_body(raw, resp)
        finally:
            try:
                resp.close()
            except Exception:
                pass

        title, text = _extract_text(html)
        truncated = len(text) > max_chars
        if truncated:
            text = text[:max_chars]

        return jsonify({
            "ok": True,
            "url": final_url,
            "title": title,
            "text": text,
            "truncated": truncated,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": f"unexpected: {e}"})


def register_web_research_routes(app) -> None:
    """Attach the web-research blueprint to an existing Flask app.

    CORS is handled app-wide by `flask_cors.CORS(app, origins="*")` in
    server.py, so these routes inherit the same policy as /execute and /ai/chat.
    """
    app.register_blueprint(web_research_bp)
