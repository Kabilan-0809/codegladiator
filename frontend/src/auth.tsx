import React, { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { jwtDecode } from 'jwt-decode';

const TOKEN_KEY = 'gladiator_token';

interface JWTPayload {
  sub: string;
  alias: string;
  iat: number;
  exp: number;
}

interface AuthState {
  token: string | null;
  alias: string | null;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthState>({ token: null, alias: null, isAuthenticated: false });

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  window.dispatchEvent(new Event('token-changed'));
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new Event('token-changed'));
}

function decodeToken(token: string): JWTPayload | null {
  try {
    const decoded = jwtDecode<JWTPayload>(token);
    if (decoded.exp * 1000 < Date.now()) {
      clearToken();
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>(() => {
    const token = getToken();
    if (token) {
      const decoded = decodeToken(token);
      if (decoded) {
        return { token, alias: decoded.alias, isAuthenticated: true };
      }
    }
    return { token: null, alias: null, isAuthenticated: false };
  });

  useEffect(() => {
    const handleTokenChange = () => {
      const token = getToken();
      if (token) {
        const decoded = decodeToken(token);
        if (decoded) {
          setAuthState({ token, alias: decoded.alias, isAuthenticated: true });
          return;
        }
      }
      setAuthState({ token: null, alias: null, isAuthenticated: false });
    };

    window.addEventListener('token-changed', handleTokenChange);
    return () => window.removeEventListener('token-changed', handleTokenChange);
  }, []);

  return <AuthContext.Provider value={authState}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
