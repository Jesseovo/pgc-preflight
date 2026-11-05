import { createElement, type ComponentProps, type ComponentType } from 'react';

export function screen<Module extends { default: ComponentType<any> }>(loader: () => Promise<Module>) {
  let loaded: Module | undefined;
  let pending: Promise<Module> | undefined;
  function preload() {
    return pending ??= loader().then(module => {
      loaded = module;
      return module;
    });
  }
  function Screen(props: ComponentProps<Module['default']>) {
    if (!loaded) throw preload();
    return createElement(loaded.default, props);
  }
  return Object.assign(Screen, { preload });
}
