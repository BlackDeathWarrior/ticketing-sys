import { useEffect, useState } from 'react';

export type Route = 'dashboard' | 'elements' | 'settings' | 'kb';

function parse(): Route {
  const [first] = window.location.hash.replace(/^#\/?/, '').split('/');
  if (first === 'elements') return 'elements';
  if (first === 'settings') return 'settings';
  if (first === 'kb') return 'kb';
  return 'dashboard';
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onChange = () => {
      const next = parse();
      setRoute((prev) => {
        if (prev !== next) window.scrollTo({ top: 0 });
        return next;
      });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const hrefFor = (route: Route) => (route === 'dashboard' ? '#/' : `#/${route}`);
