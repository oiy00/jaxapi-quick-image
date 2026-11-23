"use client";

import { FormEvent, useState } from "react";
import { Loader2 } from "lucide-react";
import { loginWithPassword, loginWithTotp } from "@/lib/account";
import { JaxClientError } from "@/lib/jax-client";
import type { PublicSettings, StoredSession } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type LoginScreenProps = {
  settings: PublicSettings | null;
  settingsError: string | null;
  onLoggedIn: (session: StoredSession) => void;
};

export function LoginScreen({ settings, settingsError, onLoggedIn }: LoginScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [tempToken, setTempToken] = useState<string | null>(null);
  const [masked, setMasked] = useState<string | undefined>();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const captchaOn = Boolean(
    settings?.turnstile_enabled || settings?.tencent_captcha_enabled || settings?.aliyun_captcha_enabled,
  );
  const agreementOn = settings?.login_agreement_enabled !== false;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (captchaOn) return;
    if (agreementOn && !agreed) {
      setError("请先确认已阅读 JaxApi 的服务条款。");
      return;
    }
    setPending(true);
    try {
      if (tempToken) {
        onLoggedIn(await loginWithTotp(tempToken, code.trim()));
        return;
      }
      const result = await loginWithPassword(email.trim(), password);
      if (result.kind === "totp") {
        setTempToken(result.tempToken);
        setMasked(result.emailMasked);
        setPassword("");
        return;
      }
      onLoggedIn(result.session);
    } catch (cause) {
      setError(cause instanceof JaxClientError || cause instanceof Error ? cause.message : "登录失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-12">
      <h1 className="flex items-baseline gap-2.5">
        <span className="font-[family-name:var(--font-display)] text-4xl font-medium tracking-tight">JaxApi</span>
        <span className="text-xl text-muted-foreground">媒体台</span>
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        用 jaxapi.top 的账户登录。余额、密钥和分组都沿用中转站。
      </p>
      <form onSubmit={onSubmit} className="mt-8 space-y-4 rounded-xl bg-card p-5 ring-1 ring-border">
        {settingsError ? (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{settingsError}</p>
        ) : null}
        {captchaOn ? (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm leading-6 text-destructive">
            站点已开启验证码，这个页面还不能完成验证。请先到{" "}
            <a className="underline" href="https://jaxapi.top" target="_blank" rel="noreferrer">
              jaxapi.top
            </a>{" "}
            登录。
          </p>
        ) : null}
        {tempToken ? (
          <div className="space-y-2">
            <Label htmlFor="code">两步验证码</Label>
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={masked ? `已发送到 ${masked}` : "6 位验证码"}
            />
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="email">邮箱</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </>
        )}
        {agreementOn && !tempToken ? (
          <label className="flex items-start gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="mt-1"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
            />
            <span>
              我已阅读 JaxApi 的服务条款与使用政策。
              <a className="ml-1 text-primary underline" href="https://jaxapi.top" target="_blank" rel="noreferrer">
                打开主站
              </a>
            </span>
          </label>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" className="h-10 w-full" disabled={pending || captchaOn}>
          {pending ? <Loader2 className="animate-spin" /> : null}
          {tempToken ? "完成验证" : "登录"}
        </Button>
        {tempToken ? (
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => {
              setTempToken(null);
              setCode("");
            }}
          >
            返回密码登录
          </Button>
        ) : null}
      </form>
      <p className="mt-4 text-center text-xs text-muted-foreground">
        还没有账户？到{" "}
        <a className="text-primary underline" href="https://jaxapi.top" target="_blank" rel="noreferrer">
          jaxapi.top
        </a>{" "}
        注册。密钥在{" "}
        <a className="text-primary underline" href="https://jaxapi.top/keys" target="_blank" rel="noreferrer">
          密钥页
        </a>{" "}
        管理。
      </p>
    </main>
  );
}
