// Hash-based router. Exposes a reactive `router.route` and `navigate(name)`.
//
// Route map:
//   ''        | '#/'         → 'landing'
//   '#/explore'                → 'explore'
//   '#/manage'                 → 'manage'
//   '#/auth'                   → 'auth'
//   '#/studio' | '#/create'    → 'studio'
//   anything else              → 'landing'

function parseHash(hash) {
  const h = (hash || '').trim();
  if (h === '' || h === '#' || h === '#/') return 'landing';
  if (h === '#/explore') return 'explore';
  if (h === '#/manage') return 'manage';
  if (h === '#/auth') return 'auth';
  if (h === '#/studio' || h === '#/create') return 'studio';
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
    case 'explore':
      hash = '#/explore';
      break;
    case 'manage':
      hash = '#/manage';
      break;
    case 'auth':
      hash = '#/auth';
      break;
    default:
      hash = '#/';
  }
  window.location.hash = hash;
}
