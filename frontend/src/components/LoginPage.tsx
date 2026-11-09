import { useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../api/client";
import { Alert, Button, Input } from "@ui";

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "登录失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-shell">
      <motion.form
        className="login-card"
        onSubmit={handleSubmit}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        <h1>城市招聘配置管理</h1>
        <p className="login-subtitle">登录以继续</p>

        <div className="login-fields">
          <Input id="login-username" label="账号" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
          <Input
            id="login-password"
            label="密码"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>

        {error && (
          <div className="login-error">
            <Alert tone="danger" title={error} />
          </div>
        )}

        <Button type="submit" className="login-submit" loading={submitting}>
          {submitting ? "登录中…" : "登录"}
        </Button>
      </motion.form>
    </div>
  );
}
