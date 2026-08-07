let highSensitivityScopes = new Set<string>();

export function setHighSensitivityScopes(scopes: string[]): void {
  highSensitivityScopes = new Set(scopes);
}

export function checkScopeSensitivity(scopeId: string): "L1" | null {
  return highSensitivityScopes.has(scopeId) ? "L1" : null;
}
