import { AsyncLocalStorage } from 'node:async_hooks';
const context = new AsyncLocalStorage();
export const delegatedContext = () => context.getStore();
export const withDelegation = (value, fn) => context.run(value, fn);
export function assertDelegation() {
  context.getStore()?.assertActive();
}
