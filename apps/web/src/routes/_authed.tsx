import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "../components/AppShell";
import { metaQueryOptions } from "../lib/api";
import { authClient } from "../lib/auth";

// Pathless layout for signed-in pages. Its beforeLoad runs before any child route loads.
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ location }) => {
    const { data } = await authClient.getSession();
    if (!data) throw redirect({ to: "/login", search: { redirect: location.href } });
    return { user: data.user };
  },
  loader: ({ context }) => context.queryClient.query({ ...metaQueryOptions, staleTime: "static" }),
  component: AuthedLayout,
});

function AuthedLayout() {
  const { user } = Route.useRouteContext();
  return (
    <AppShell user={user}>
      <Outlet />
    </AppShell>
  );
}
