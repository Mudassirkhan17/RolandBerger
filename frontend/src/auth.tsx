import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
  permissions: string[];
  created_at: string;
};

type AuthCtx = {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  hasPermission: (feature: string) => boolean;
};

const Ctx = createContext<AuthCtx | null>(null);

const TOKEN_KEY = "helios_token";

async function apiAuth<T>(path: string, body: object): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json() as { detail?: string } & T;
  if (!res.ok) throw new Error((data as { detail?: string }).detail ?? "Request failed");
  return data;
}

type TokenPayload = { access_token: string; user: AuthUser };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore session on mount
  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (!stored) { setLoading(false); return; }
    fetch("/api/auth/me", { headers: { Authorization: `Bearer ${stored}` } })
      .then((r) => r.ok ? r.json() as Promise<AuthUser> : Promise.reject())
      .then((u) => { setUser(u); setToken(stored); })
      .catch(() => { localStorage.removeItem(TOKEN_KEY); setToken(null); })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiAuth<TokenPayload>("/api/auth/login", { email, password });
    localStorage.setItem(TOKEN_KEY, data.access_token);
    localStorage.setItem("helios_user_name", data.user.name);
    setToken(data.access_token);
    setUser(data.user);
  }, []);

  const register = useCallback(async (name: string, email: string, password: string) => {
    const data = await apiAuth<TokenPayload>("/api/auth/register", { name, email, password });
    localStorage.setItem(TOKEN_KEY, data.access_token);
    localStorage.setItem("helios_user_name", data.user.name);
    setToken(data.access_token);
    setUser(data.user);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem("helios_user_name");
    setToken(null);
    setUser(null);
  }, []);

  const hasPermission = useCallback((feature: string) => {
    if (!user) return false;
    if (user.role === "admin") return true;
    return user.permissions.includes(feature.toLowerCase());
  }, [user]);

  return (
    <Ctx.Provider value={{ user, token, loading, login, register, logout, hasPermission }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
