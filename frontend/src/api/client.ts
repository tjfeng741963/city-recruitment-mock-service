export interface City {
  id: number;
  city_name: string;
  province: string;
  recruitment_status: string;
  is_primary: boolean;
  flow_type: string;
  created_at?: string;
  updated_at?: string;
}

export interface ListResult<T> {
  items: T[];
  total: number;
}

export interface LoginResult {
  access_token: string;
  token_type: "bearer";
}

export interface AuthMe {
  username: string;
  role: "admin" | "customer" | "recruiter";
  recruiter_id: string;
  recruiter_type: string;
}

export class ApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
}

function getToken(): string | null {
  return localStorage.getItem("rea_token");
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem("rea_token", token);
  else localStorage.removeItem("rea_token");
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    throw new ApiError(response.status, detail);
  }
  return body as T;
}

export const api = {
  login(username: string, password: string) {
    return request<LoginResult>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  },
  me() {
    return request<AuthMe>("/api/v1/auth/me");
  },
  listCities() {
    return request<ListResult<City>>("/api/v1/cities?page_size=200");
  },
  setCityStatus(id: number, recruitment_status: string) {
    return request<City>(`/api/v1/cities/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ recruitment_status }),
    });
  },
};
