// Hash-based router. Exposes a reactive `router.route` and `navigate(name)`.
//
// Route map:
//   ''        | '#/'         → 'landing'
//   '#/manage'                 → 'manage'
//   '#/auth'                   → 'auth'
//   '#/studio' | '#/create'    → 'studio'
//   '#/pricing'                → 'pricing'
//   anything else              → 'landing'
//
// Query strings on the hash are tolerated: '#/studio?checkout=success' and
// '#/pricing?checkout=cancel' match their base route. We strip everything from
// the first '?' before comparing.

function parseHash(hash) {
  const h = (hash || '').trim();
  const base = h.split('?')[0];
  if (base === '' || base === '#' || base === '#/') return 'landing';
  if (base === '#/manage') return 'manage';
  if (base === '#/auth') return 'auth';
  if (base === '#/pricing') return 'pricing';
  if (base === '#/studio' || base === '#/create') return 'studio';
  return 'landing';
}

function createRouter() {
  let route = $state(parseHash(typeof window !== 'undefined' ? window.location.hash : ''));

  if (typeof window !== 'undefined') {
    const update = () => {
      route = parseHash(window.location.hash);
    };
    window.addEventListener('hashchange', update);
    window.addEventListener('load', update);
  }

  return {
    get route() {
      return route;
    },
  };
}

export const router = createRouter();

export function navigate(name) {
  if (typeof window === 'undefined') return;
  let hash = '#/';
  switch (name) {
    case 'landing':
      hash = '#/';
      break;
    case 'studio':
      hash = '#/studio';
      break;
    case 'manage':
      hash = '#/manage';
      break;
    case 'auth':
      hash = '#/auth';
      break;
    case 'pricing':
      hash = '#/pricing';
      break;
    default:
      hash = '#/';
  }
  window.location.hash = hash;
}
