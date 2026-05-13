import LoginClient from "./login-client";

export const dynamic = "force-dynamic";

export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  return <LoginClient searchParamsPromise={searchParams} />;
}
