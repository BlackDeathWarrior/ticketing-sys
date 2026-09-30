import { useEffect, useState } from 'react';

export type Route = 'dashboard' | 'elements';

function parse(): Route {
  return window.location.hash.replace(/^#\/?/, '') === 'elements' ? 'elements' : 'dashboard';
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onChange = () => {
      setRoute(parse());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const hrefFor = (route: Route) => (route === 'elements' ? '#/elements' : '#/');
