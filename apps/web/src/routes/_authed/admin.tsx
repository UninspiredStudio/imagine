import { Alert } from "@imagine/components/components/Alert";
import { Avatar } from "@imagine/components/components/Avatar";
import { Badge } from "@imagine/components/components/Badge";
import { Button } from "@imagine/components/components/Button";
import { Select } from "@imagine/components/components/Select";
import { TextField } from "@imagine/components/components/TextField";
import {
  FeatherAlertCircle,
  FeatherArrowLeft,
  FeatherBox,
  FeatherClockAlert,
  FeatherKeyRound,
  FeatherLogOut,
  FeatherMail,
  FeatherMailCheck,
  FeatherMailX,
  FeatherRotateCw,
  FeatherSearch,
  FeatherSearchX,
  FeatherSend,
  FeatherShieldAlert,
  FeatherShieldOff,
  FeatherUserMinus,
  FeatherX,
} from "@subframe/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Hint } from "../../components/Hint";
import { ConfirmModal } from "../../components/Modal";
import { EmptyPanel, LoadError, LoadingRows, PageHeader, PageMessage, SectionHeading } from "../../components/Page";
import {
  apiClient,
  ApiError,
  apiError,
  invitesQueryOptions,
  isAdmin,
  metaQueryOptions,
  sendInvite,
  unwrap,
  usersQueryOptions,
  type Role,
} from "../../lib/api";
import { authClient } from "../../lib/auth";
import { EMAIL_ERROR, initials, isEmail } from "../../lib/email";
import { DAY, formatDate, formatDateTime, formatRelative } from "../../lib/format";
import { notifyFailure, notifySuccess } from "../../lib/notify";

export const Route = createFileRoute("/_authed/admin")({
  component: AdminPage,
});

type Invite = Awaited<ReturnType<NonNullable<typeof invitesQueryOptions.queryFn>>>[number];
type User = Awaited<ReturnType<NonNullable<typeof usersQueryOptions.queryFn>>>[number];
// The row to highlight after an invite is sent or refused.
type Highlight = { email: string; tone: "success" | "warning" };

function AdminPage() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();
  const { data: meta } = useQuery(metaQueryOptions);
  const [highlight, setHighlight] = useState<Highlight | null>(null);

  if (!isAdmin(user)) {
    return (
      <PageMessage
        icon={<FeatherShieldOff />}
        title="Admins only"
        description="You need the Admin role to manage users and invites. Ask an admin of this registry if you need access."
      >
        <Button variant="neutral-secondary" icon={<FeatherArrowLeft />} onClick={() => navigate({ to: "/" })}>
          Back to Images
        </Button>
      </PageMessage>
    );
  }

  const host = meta?.host ?? "";
  return (
    <>
      <PageHeader title="Admin" description={`Manage who can sign in to ${host}.`} />
      <InviteForm onHighlight={setHighlight} />
      <PendingInvites highlight={highlight} />
      <Users currentUserId={user.id} host={host} />
    </>
  );
}

function InviteForm({ onHighlight }: { onHighlight: (highlight: Highlight | null) => void }) {
  const queryClient = useQueryClient();
  const { data: invites } = useQuery(invitesQueryOptions);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [problem, setProblem] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: sendInvite,
    onSuccess: async (_, invite) => {
      setEmail("");
      setRole("user");
      onHighlight({ email: invite.email, tone: "success" });
      notifySuccess(`Invite sent to ${invite.email}`, "They have 7 days to accept.");
      await queryClient.invalidateQueries(invitesQueryOptions);
    },
    onError: (error, invite) => {
      if (error instanceof ApiError && error.status === 409) setProblem(`${invite.email} already has an account.`);
      else notifyFailure("Couldn't send the invite")(error);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (send.isPending) return;
    const address = email.trim().toLowerCase();
    onHighlight(null);
    if (!isEmail(address)) {
      setProblem(EMAIL_ERROR);
    } else if (invites?.some((invite) => invite.email === address)) {
      // The server would replace the invite, which breaks the link already sent. Resend does that on purpose.
      setProblem(`${address} already has a pending invite. Resend it from the list below.`);
      onHighlight({ email: address, tone: "warning" });
    } else {
      setProblem(null);
      send.mutate({ email: address, role });
    }
  }

  return (
    <form
      noValidate
      onSubmit={submit}
      className="flex w-full flex-col items-start gap-4 rounded-lg border border-solid border-neutral-border bg-default-background px-5 py-5 shadow-sm"
    >
      <div className="flex flex-col items-start gap-1">
        <h2 className="text-heading-3 font-heading-3 text-default-font">Invite someone</h2>
        <span className="text-body font-body text-subtext-color">
          They&apos;ll get an email with a link to sign in. Invites expire after 7 days.
        </span>
      </div>
      <div className="flex w-full items-start gap-3 mobile:flex-col mobile:items-stretch">
        <TextField
          className="h-auto grow shrink-0 basis-0 mobile:flex-none"
          label="Email"
          error={problem !== null}
          helpText={problem}
          icon={<FeatherMail />}
          iconRight={problem ? <FeatherAlertCircle /> : null}
        >
          <TextField.Input
            type="email"
            placeholder="name@acme.dev"
            aria-invalid={problem !== null}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setProblem(null);
            }}
          />
        </TextField>
        <Select
          className="h-auto w-40 flex-none mobile:w-full"
          label="Role"
          value={role}
          onValueChange={(value) => setRole(value as Role)}
        >
          <Select.Item value="user">Member</Select.Item>
          <Select.Item value="admin">Admin</Select.Item>
        </Select>
        {/* Lines up with the inputs, below their labels. */}
        <Button
          type="submit"
          className="mt-5 mobile:mt-0"
          icon={<FeatherSend />}
          loading={send.isPending}
          disabled={send.isPending}
        >
          Send invite
        </Button>
      </div>
    </form>
  );
}

function PendingInvites({ highlight }: { highlight: Highlight | null }) {
  const queryClient = useQueryClient();
  const { data: invites, isError, refetch } = useQuery(invitesQueryOptions);
  const [revoking, setRevoking] = useState<Invite | null>(null);

  // A new invite replaces the pending one and gets a new link.
  const resend = useMutation({
    mutationFn: (invite: Invite) => sendInvite({ email: invite.email, role: invite.role }),
    onSuccess: async (_, invite) => {
      await queryClient.invalidateQueries(invitesQueryOptions);
      notifySuccess(`Invite resent to ${invite.email}`, "The new link works for 7 days. The old one no longer works.");
    },
    onError: notifyFailure("Couldn't resend the invite"),
  });

  const revoke = useMutation({
    mutationFn: async (invite: Invite) => {
      const res = await apiClient.api.invites.$delete({ query: { id: invite.id } });
      if (!res.ok) throw await apiError(res);
    },
    onSuccess: (_, invite) => {
      notifySuccess(`Invite for ${invite.email} revoked`);
      setRevoking(null);
    },
    onError: notifyFailure("Couldn't revoke the invite"),
    // Also after a failure: the invite may have been accepted or revoked elsewhere.
    onSettled: () => queryClient.invalidateQueries(invitesQueryOptions),
  });

  return (
    <div className="flex w-full flex-col items-start gap-3 pt-2">
      <SectionHeading title="Pending invites" count={invites?.length} />
      {!invites ? (
        isError ? (
          <LoadError what="invites" onRetry={() => void refetch()} />
        ) : (
          <LoadingRows />
        )
      ) : invites.length === 0 ? (
        <div className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-border bg-page-background px-6 py-6">
          <FeatherMailCheck className="text-heading-3 font-heading-3 text-subtext-color" />
          <span className="text-body font-body text-subtext-color">No pending invites</span>
        </div>
      ) : (
        <div className="flex w-full flex-col items-start overflow-hidden rounded-lg border border-solid border-neutral-border bg-default-background">
          <div className="flex w-full items-center gap-4 border-b border-solid border-neutral-border bg-page-background px-4 py-2 mobile:hidden">
            <span className="grow shrink-0 basis-0 text-caption-bold font-caption-bold text-subtext-color">Email</span>
            <span className="w-24 flex-none text-caption-bold font-caption-bold text-subtext-color">Role</span>
            <span className="w-36 flex-none text-caption-bold font-caption-bold text-subtext-color">Invited by</span>
            <span className="w-28 flex-none text-caption-bold font-caption-bold text-subtext-color">Sent</span>
            <span className="w-28 flex-none text-caption-bold font-caption-bold text-subtext-color">Expires</span>
            <div className="flex w-40 flex-none items-start" />
          </div>
          {invites.map((invite) => (
            <div
              key={invite.id}
              className={`flex w-full items-center gap-4 border-b border-solid border-neutral-border px-4 py-3 last:border-none mobile:flex-wrap mobile:gap-2 ${
                highlight?.email !== invite.email
                  ? ""
                  : highlight.tone === "success"
                    ? "bg-success-50"
                    : "bg-warning-50"
              }`}
            >
              <span className="min-w-[0px] grow shrink-0 basis-0 text-body font-body text-default-font break-all mobile:basis-full">
                {invite.email}
              </span>
              <div className="flex w-24 flex-none items-center">
                <Badge variant={invite.role === "admin" ? "brand" : "neutral"}>
                  {invite.role === "admin" ? "Admin" : "Member"}
                </Badge>
              </div>
              <span
                className="w-36 flex-none text-body font-body text-secondary-font truncate mobile:hidden"
                title={invite.invitedBy}
              >
                {invite.invitedBy}
              </span>
              <span
                className="w-28 flex-none text-body font-body text-secondary-font mobile:hidden"
                title={formatDateTime(invite.createdAt)}
              >
                {formatRelative(invite.createdAt)}
              </span>
              <Expiry expiresAt={invite.expiresAt} />
              <div className="flex w-40 flex-none items-center justify-end gap-1 mobile:grow mobile:shrink-0 mobile:basis-0 mobile:justify-start">
                <Button
                  variant="neutral-tertiary"
                  size="small"
                  icon={<FeatherRotateCw />}
                  disabled={resend.isPending}
                  loading={resend.isPending && resend.variables.id === invite.id}
                  onClick={() => resend.mutate(invite)}
                >
                  Resend
                </Button>
                <Button
                  variant="destructive-tertiary"
                  size="small"
                  icon={<FeatherX />}
                  onClick={() => setRevoking(invite)}
                >
                  Revoke
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {revoking ? (
        <ConfirmModal
          icon={<FeatherMailX />}
          tone="error"
          title={`Revoke invite for ${revoking.email}?`}
          description="The invite link stops working immediately. You can invite them again later."
          confirm={{ label: "Revoke invite", icon: <FeatherX /> }}
          destructive
          pending={revoke.isPending}
          onConfirm={() => revoke.mutate(revoking)}
          onClose={() => setRevoking(null)}
        />
      ) : null}
    </div>
  );
}

function Expiry({ expiresAt }: { expiresAt: string }) {
  if (Date.parse(expiresAt) - Date.now() > 1.5 * DAY) {
    return (
      <span
        className="w-28 flex-none text-body font-body text-secondary-font mobile:w-auto"
        title={formatDateTime(expiresAt)}
      >
        {formatRelative(expiresAt)}
      </span>
    );
  }
  return (
    <div className="flex w-28 flex-none items-center gap-1 mobile:w-auto" title={formatDateTime(expiresAt)}>
      <FeatherClockAlert className="text-body font-body text-warning-700" />
      <span className="text-body-bold font-body-bold text-warning-700">{formatRelative(expiresAt)}</span>
    </div>
  );
}

// The server enforces the last-admin rule. This page only explains it before the attempt.
function Users({ currentUserId, host }: { currentUserId: string; host: string }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: users, isError, refetch } = useQuery(usersQueryOptions);
  const [search, setSearch] = useState("");
  const [removing, setRemoving] = useState<User | null>(null);

  const changeRole = useMutation({
    mutationFn: async ({ user, role }: { user: User; role: Role }) =>
      unwrap(await authClient.admin.setRole({ userId: user.id, role })),
    onSuccess: (_, { user, role }) => {
      notifySuccess(`${user.email} is now ${role === "admin" ? "an admin" : "a member"}`);
      // The shell reads the role from the session, so an admin who demotes themself loses this page at once.
      if (user.id === currentUserId) void router.invalidate();
    },
    onError: notifyFailure("Couldn't change the role"),
    onSettled: () => queryClient.invalidateQueries(usersQueryOptions),
  });

  const remove = useMutation({
    mutationFn: async (user: User) => unwrap(await authClient.admin.removeUser({ userId: user.id })),
    onSuccess: (_, user) => {
      notifySuccess(`${user.email} removed`, "They no longer have access.");
      setRemoving(null);
    },
    onError: notifyFailure("Couldn't remove the user"),
    onSettled: async () => {
      await queryClient.invalidateQueries(usersQueryOptions);
      // Removing a user also deletes the pending invites they sent.
      await queryClient.invalidateQueries(invitesQueryOptions);
    },
  });

  if (!users) {
    return (
      <div className="flex w-full flex-col items-start gap-3 pt-2">
        <SectionHeading title="Users" />
        {isError ? <LoadError what="users" onRetry={() => void refetch()} /> : <LoadingRows />}
      </div>
    );
  }

  const admins = users.filter((user) => isAdmin(user) && user.active);
  const onlyAdminId = admins.length === 1 ? admins[0]?.id : undefined;
  const shown = users.filter((user) => user.email.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="flex w-full flex-col items-start gap-3 pt-2">
      <div className="flex w-full items-center gap-3 mobile:flex-col mobile:items-stretch">
        <SectionHeading title="Users" count={users.length} />
        <TextField className="h-auto w-64 flex-none mobile:w-full" icon={<FeatherSearch />}>
          <TextField.Input
            aria-label="Search users by email"
            placeholder="Search by email"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </TextField>
      </div>
      {onlyAdminId === currentUserId ? (
        <Alert
          icon={<FeatherShieldAlert />}
          title="You're the only admin"
          description="You can't remove yourself or change your own role until another admin exists."
        />
      ) : null}
      {shown.length === 0 ? (
        <EmptyPanel
          icon={<FeatherSearchX />}
          title={`No users match “${search.trim()}”`}
          description="Check the spelling, or search part of an email."
        >
          <Button variant="neutral-secondary" icon={<FeatherX />} onClick={() => setSearch("")}>
            Clear search
          </Button>
        </EmptyPanel>
      ) : (
        <div className="flex w-full flex-col items-start overflow-hidden rounded-lg border border-solid border-neutral-border bg-default-background">
          <div className="flex w-full items-center gap-4 border-b border-solid border-neutral-border bg-page-background px-4 py-2 mobile:hidden">
            <span className="grow shrink-0 basis-0 text-caption-bold font-caption-bold text-subtext-color">User</span>
            <span className="w-32 flex-none text-caption-bold font-caption-bold text-subtext-color">Role</span>
            <span className="w-28 flex-none text-caption-bold font-caption-bold text-subtext-color">Joined</span>
            <span className="w-28 flex-none text-caption-bold font-caption-bold text-subtext-color">Last active</span>
            <div className="flex w-24 flex-none items-start" />
          </div>
          {shown.map((user) => {
            const isYou = user.id === currentUserId;
            const isOnlyAdmin = user.id === onlyAdminId;
            const keepReason = isYou
              ? "You can't remove yourself"
              : isOnlyAdmin
                ? "The last admin can't be removed"
                : null;
            return (
              <div
                key={user.id}
                className="flex w-full items-center gap-4 border-b border-solid border-neutral-border px-4 py-3 last:border-none mobile:flex-wrap mobile:gap-2"
              >
                <div className="flex min-w-[0px] grow shrink-0 basis-0 items-center gap-3 mobile:w-full mobile:basis-full">
                  <Avatar variant={isYou ? "brand" : "neutral"} size="small">
                    {initials(user.email)}
                  </Avatar>
                  <span className="min-w-[0px] text-body font-body text-default-font break-all">{user.email}</span>
                  {isYou ? <span className="text-body font-body text-subtext-color">(you)</span> : null}
                </div>
                <div title={isOnlyAdmin ? "The last admin can't be demoted" : undefined}>
                  <Select
                    className="h-auto w-32 flex-none"
                    disabled={isOnlyAdmin || changeRole.isPending}
                    value={isAdmin(user) ? "admin" : "user"}
                    onValueChange={(role) => changeRole.mutate({ user, role: role as Role })}
                  >
                    <Select.Item value="user">Member</Select.Item>
                    <Select.Item value="admin">Admin</Select.Item>
                  </Select>
                </div>
                <span className="w-28 flex-none text-body font-body text-secondary-font mobile:hidden">
                  {formatDate(user.createdAt)}
                </span>
                <span
                  className="w-28 flex-none text-body font-body text-secondary-font mobile:hidden"
                  title={user.lastActiveAt ? formatDateTime(user.lastActiveAt) : undefined}
                >
                  {isYou ? "Active now" : user.lastActiveAt ? formatRelative(user.lastActiveAt) : "—"}
                </span>
                <div className="flex w-24 flex-none items-center justify-end">
                  {keepReason ? (
                    <Hint text={keepReason}>
                      <Button disabled={true} variant="neutral-tertiary" size="small" icon={<FeatherUserMinus />}>
                        Remove
                      </Button>
                    </Hint>
                  ) : (
                    <Button
                      variant="destructive-tertiary"
                      size="small"
                      icon={<FeatherUserMinus />}
                      onClick={() => setRemoving(user)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {removing ? (
        <ConfirmModal
          icon={<FeatherUserMinus />}
          tone="error"
          title={`Remove ${removing.email}?`}
          description={`They lose access to ${host} right away.`}
          confirm={{ label: "Remove user", icon: <FeatherUserMinus /> }}
          destructive
          pending={remove.isPending}
          onConfirm={() => remove.mutate(removing)}
          onClose={() => setRemoving(null)}
        >
          <ul className="flex w-full flex-col items-start gap-2 rounded-md bg-page-background px-3 py-3 text-body font-body text-default-font">
            <li className="flex items-start gap-2">
              <FeatherLogOut className="mt-0.5 flex-none text-body font-body text-subtext-color" />
              Signed out on every device
            </li>
            <li className="flex items-start gap-2">
              <FeatherKeyRound className="mt-0.5 flex-none text-body font-body text-subtext-color" />
              All their personal access tokens are revoked — CI using them will fail
            </li>
            <li className="flex items-start gap-2">
              <FeatherBox className="mt-0.5 flex-none text-body font-body text-subtext-color" />
              Images they pushed stay in the registry
            </li>
          </ul>
        </ConfirmModal>
      ) : null}
    </div>
  );
}
