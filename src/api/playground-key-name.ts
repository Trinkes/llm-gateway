// [fork] W23: name of the key the dashboard playground issues for itself
// (playground.ts). Reserved: the keys API refuses it, so a key an admin made
// can never be taken over by the playground's secret rotation.
export const PLAYGROUND_KEY_NAME = "Playground";

export function isReservedKeyName(name: string): boolean {
  return name.trim().toLowerCase() === PLAYGROUND_KEY_NAME.toLowerCase();
}
