import type { ScadStudioApi } from './index';

declare global {
  interface Window {
    scadstudio: ScadStudioApi;
  }
}
