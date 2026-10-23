if (/^\/admin\/?$/.test(location.pathname)) await import('./admin');
else if (/^\/login\/?$/.test(location.pathname)) await import('./login');
else await import('./main');
export {};
