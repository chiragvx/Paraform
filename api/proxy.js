/**
 * Generic LLM API proxy.
 *
 * Usage: POST /api/proxy
 *   x-target-url: <full upstream URL including any query params>
 *   All other headers + body forwarded verbatim to the upstream.
 *   Response (including SSE streams) piped straight back to the caller.
 *
 * Works as both a Vercel serverless function (default export)
 * and a Vite dev-server middleware (named export proxyHandler).
 */

const SKIP_REQ_HEADERS = new Set([
    'host', 'origin', 'referer', 'x-forwarded-for', 'x-forwarded-host',
    'x-forwarded-proto', 'x-target-url',
    'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
]);

const SKIP_RES_HEADERS = new Set([
    // Stripped so the browser doesn't see the upstream's CORS refusal,
    // and so we can re-set content-length correctly after piping.
    'content-encoding', 'content-length',
    'access-control-allow-origin', 'access-control-allow-headers',
    'access-control-allow-methods', 'access-control-allow-credentials',
]);

export async function proxyHandler(req, res) {
    // CORS preflight
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
    }

    const targetUrl = req.headers['x-target-url'];
    if (!targetUrl) {
        res.statusCode = 400;
        res.end('Missing x-target-url header');
        return;
    }

    // Collect request body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    // Build upstream headers (drop hop-by-hop + proxy-specific ones)
    const forwardHeaders = {};
    for (const [key, val] of Object.entries(req.headers)) {
        if (!SKIP_REQ_HEADERS.has(key.toLowerCase())) {
            forwardHeaders[key] = val;
        }
    }

    let upstream;
    try {
        upstream = await fetch(targetUrl, {
            method: req.method,
            headers: forwardHeaders,
            body,
            // Required in Node 18+ when sending a body via fetch
            duplex: 'half',
        });
    } catch (err) {
        res.statusCode = 502;
        res.end(`Proxy error: ${err.message}`);
        return;
    }

    res.statusCode = upstream.status;
    upstream.headers.forEach((val, key) => {
        if (!SKIP_RES_HEADERS.has(key.toLowerCase())) res.setHeader(key, val);
    });
    // Keep SSE / streaming responses unfragmented by proxies
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
            }
        } finally {
            reader.releaseLock();
        }
    }
    res.end();
}

// Vercel serverless entry point
export default proxyHandler;
