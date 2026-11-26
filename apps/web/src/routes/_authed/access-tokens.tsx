import { Alert } from "@imagine/components/components/Alert";
import { Badge } from "@imagine/components/components/Badge";
import { Button } from "@imagine/components/components/Button";
import { RadioCardGroup } from "@imagine/components/components/RadioCardGroup";
import { Select } from "@imagine/components/components/Select";
import { TextField } from "@imagine/components/components/TextField";
import {
  FeatherAlertTriangle,
  FeatherBan,
  FeatherClock,
  FeatherClockAlert,
  FeatherCopy,
  FeatherDownload,
  FeatherEyeOff,
  FeatherKeyRound,
  FeatherPlus,
  FeatherUpload,
} from "@subframe/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { CopyButton } from "../../components/Copy";
import { ConfirmModal, Modal, ModalActions, ModalHeading } from "../../components/Modal";
import { EmptyPanel, LoadError, LoadingRows, PageHeader } from "../../components/Page";
import { apiClient, apiError, accessTokensQueryOptions, metaQueryOptions, unwrap } from "../../lib/api";
import { authClient } from "../../lib/auth";
import { DAY, formatDate, formatDateTime, formatRelative } from "../../lib/format";
import { copy, notifyFailure, notifySuccess } from "../../lib/notify";

const EXPIRING_SOON_MS = 14 * DAY;
const NAME_MAX = 32;
const EXPIRY_DAYS: Record<string, number | undefined> = { "30": 30, "90": 90, "365": 365, never: undefined };

export const Route = createFileRoute("/_authed/access-tokens")({
  component: AccessTokensPage,
});

type AccessToken = Awaited<ReturnType<NonNullable<typeof accessTokensQueryOptions.queryFn>>>[number];
type Access = "read" | "read-write";
type CreatedKey = { id: string; key: string; name: string; access: Access; expiresAt: string | null };

const canWrite = (key: AccessToken) => {
  const permissions = key.permissions as Record<string, string[]> | null | undefined;
  return permissions?.registry?.includes("write") ?? false;
};
const prefix = (key: AccessToken) => (key.start ? `${key.start}…` : "");
const scopeLabel = (write: boolean) => (write ? "Read & write" : "Read");

function AccessTokensPage() {
  const { user } = Route.useRouteContext();
  const { data: meta } = useQuery(metaQueryOptions);
  const { data: keys, isError, refetch } = useQuery(accessTokensQueryOptions);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [revoking, setRevoking] = useState<AccessToken | null>(null);

  return (
    <>
      <PageHeader
        title="Personal access tokens"
        description="Use a token as the password for docker login. Your username is your email."
        actions={
          keys?.length ? (
            <Button icon={<FeatherPlus />} onClick={() => setCreating(true)}>
              Create token
            </Button>
          ) : null
        }
      />
      {!keys ? (
        isError ? (
          <LoadError what="Personal access tokens" onRetry={() => void refetch()} />
        ) : (
          <LoadingRows />
        )
      ) : keys.length === 0 ? (
        <EmptyPanel
          brand
          icon={<FeatherKeyRound />}
          title="No personal access tokens yet"
          description="A personal access token is the password for docker login. Create one to push images from your laptop or CI, or to pull private images."
        >
          <span className="rounded-md border border-solid border-neutral-border bg-default-background px-3 py-1.5 text-monospace-caption font-monospace-caption text-secondary-font break-all">
            docker login {meta?.host} -u {user.email}
          </span>
          <Button icon={<FeatherPlus />} onClick={() => setCreating(true)}>
            Create your first token
          </Button>
        </EmptyPanel>
      ) : (
        <div className="flex w-full flex-col items-start overflow-hidden rounded-lg border border-solid border-neutral-border bg-default-background">
          <div className="flex w-full items-center gap-4 border-b border-solid border-neutral-border bg-page-background px-4 py-2 mobile:hidden">
            <span className="grow shrink-0 basis-0 text-caption-bold font-caption-bold text-subtext-color">Token</span>
            <span className="w-32 flex-none text-caption-bold font-caption-bold text-subtext-color">Scope</span>
            <span className="w-28 flex-none text-caption-bold font-caption-bold text-subtext-color">Created</span>
            <span className="w-28 flex-none text-caption-bold font-caption-bold text-subtext-color">Last used</span>
            <span className="w-32 flex-none text-caption-bold font-caption-bold text-subtext-color">Expires</span>
            <div className="flex w-24 flex-none items-start" />
          </div>
          {keys.map((key) => (
            <TokenRow key={key.id} token={key} isNew={key.id === created?.id} onRevoke={() => setRevoking(key)} />
          ))}
        </div>
      )}
      {creating ? (
        <CreateKeyModal
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            setCreated(key);
          }}
        />
      ) : null}
      {created ? (
        <CreatedKeyModal
          created={created}
          loginCommand={`echo "$IMAGINE_TOKEN" | docker login ${meta?.host ?? ""} -u ${user.email} --password-stdin`}
          onDone={() => setCreated(null)}
        />
      ) : null}
      {revoking ? <RevokeModal token={revoking} onClose={() => setRevoking(null)} /> : null}
    </>
  );
}

function ScopeBadge({ write, muted = false }: { write: boolean; muted?: boolean }) {
  return (
    <Badge variant={write && !muted ? "brand" : "neutral"} icon={write ? <FeatherUpload /> : <FeatherDownload />}>
      {scopeLabel(write)}
    </Badge>
  );
}

function TokenRow({ token, isNew, onRevoke }: { token: AccessToken; isNew: boolean; onRevoke: () => void }) {
  const expiresIn = token.expiresAt ? new Date(token.expiresAt).getTime() - Date.now() : Infinity;
  const expired = expiresIn <= 0;
  const tone = expired ? "text-subtext-color" : "text-secondary-font";
  const background = isNew ? "bg-success-50" : expired ? "bg-page-background" : "";

  return (
    <div
      className={`flex w-full items-center gap-4 border-b border-solid border-neutral-border px-4 py-3 last:border-none mobile:flex-wrap mobile:gap-2 ${background}`}
    >
      <div className="flex min-w-[0px] grow shrink-0 basis-0 flex-col items-start mobile:basis-full">
        <span
          className={`text-body-bold font-body-bold break-words ${expired ? "text-subtext-color" : "text-default-font"}`}
        >
          {token.name ?? "Unnamed token"}
        </span>
        <span className="text-monospace-caption font-monospace-caption text-subtext-color">{prefix(token)}</span>
      </div>
      <div className="flex w-32 flex-none items-center">
        <ScopeBadge write={canWrite(token)} muted={expired} />
      </div>
      <span className={`w-28 flex-none text-body font-body mobile:hidden ${tone}`}>{formatDate(token.createdAt)}</span>
      {token.lastRequest ? (
        <span
          className={`w-28 flex-none text-body font-body mobile:hidden ${tone}`}
          title={formatDateTime(token.lastRequest)}
        >
          {formatRelative(token.lastRequest)}
        </span>
      ) : (
        <span className="w-28 flex-none text-body font-body text-subtext-color mobile:hidden">Never</span>
      )}
      {token.expiresAt && expired ? (
        <div className="flex w-32 flex-none flex-col items-start mobile:w-auto">
          <Badge variant="error" icon={<FeatherClock />}>
            Expired
          </Badge>
          <span className="text-caption font-caption text-subtext-color">{formatDate(token.expiresAt)}</span>
        </div>
      ) : token.expiresAt && expiresIn < EXPIRING_SOON_MS ? (
        <div
          className="flex w-32 flex-none items-center gap-1 mobile:w-auto"
          title={formatDateTime(token.expiresAt)}
        >
          <FeatherClockAlert className="text-body font-body text-warning-700" />
          <span className="text-body-bold font-body-bold text-warning-700">{formatRelative(token.expiresAt)}</span>
        </div>
      ) : (
        <span className="w-32 flex-none text-body font-body text-secondary-font mobile:w-auto">
          {token.expiresAt ? formatDate(token.expiresAt) : "Never"}
        </span>
      )}
      <div className="flex w-24 flex-none items-center justify-end">
        {expired ? null : (
          <Button variant="destructive-tertiary" size="small" icon={<FeatherBan />} onClick={onRevoke}>
            Revoke
          </Button>
        )}
      </div>
    </div>
  );
}

function CreateKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (key: CreatedKey) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [nameMissing, setNameMissing] = useState(false);
  const [access, setAccess] = useState<Access>("read-write");
  const [expiry, setExpiry] = useState("90");
  const days = EXPIRY_DAYS[expiry];

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiClient.api.tokens.$post({
        json: { name: name.trim(), access, expiresIn: days && (days * DAY) / 1000 },
      });
      if (!res.ok) throw await apiError(res);
      const key = await res.json();
      // The route's error statuses are not typed, so its error body stays in the union.
      if ("error" in key) throw new Error(key.error);
      return key;
    },
    // The secret is shown even if the list refresh fails, because it cannot be fetched again.
    onSuccess: (key) => {
      void queryClient.invalidateQueries(accessTokensQueryOptions);
      onCreated({ id: key.id, key: key.key, name: name.trim(), access, expiresAt: key.expiresAt });
    },
    onError: notifyFailure("Couldn't create the token"),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (create.isPending) return;
    setNameMissing(!name.trim());
    if (name.trim()) create.mutate();
  }

  return (
    <Modal wide title="Create personal access token" onClose={create.isPending ? undefined : onClose}>
      <form noValidate className="flex w-full flex-col items-start gap-5" onSubmit={submit}>
        <div className="flex w-full flex-col items-start gap-1">
          <h2 className="text-heading-3 font-heading-3 text-default-font">Create personal access token</h2>
          <span className="text-body font-body text-subtext-color">Use it as the password for docker login.</span>
        </div>
        <div className="flex w-full flex-col items-start gap-4">
          <TextField
            className="h-auto w-full flex-none"
            label="Name"
            error={nameMissing}
            helpText={nameMissing ? "Enter a name for this key." : "Helps you recognize where it's used."}
          >
            <TextField.Input
              placeholder="e.g. CI laptop"
              maxLength={NAME_MAX}
              aria-invalid={nameMissing}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNameMissing(false);
              }}
            />
          </TextField>
          <div className="flex w-full flex-col items-start gap-1">
            <span className="text-caption-bold font-caption-bold text-default-font">Scope</span>
            <RadioCardGroup
              className="h-auto w-full flex-none mobile:flex-col"
              aria-label="Scope"
              value={access}
              onValueChange={(value) => setAccess(value as Access)}
            >
              <ScopeCard value="read" title="Read" description="Pull images only" />
              <ScopeCard value="read-write" title="Read & write" description="Pull and push images" />
            </RadioCardGroup>
          </div>
          <Select
            className="h-auto w-full flex-none"
            label="Expires"
            helpText={days ? `Expires on ${formatDate(Date.now() + days * DAY)}` : "This token never expires."}
            value={expiry}
            onValueChange={setExpiry}
          >
            <Select.Item value="30">In 30 days</Select.Item>
            <Select.Item value="90">In 90 days</Select.Item>
            <Select.Item value="365">In 1 year</Select.Item>
            <Select.Item value="never">Never</Select.Item>
          </Select>
        </div>
        <ModalActions>
          <Button
            type="button"
            className="mobile:w-full"
            variant="neutral-secondary"
            disabled={create.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="mobile:w-full"
            icon={<FeatherKeyRound />}
            loading={create.isPending}
            disabled={create.isPending}
          >
            Create token
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function ScopeCard({ value, title, description }: { value: Access; title: string; description: string }) {
  return (
    <RadioCardGroup.RadioCard value={value}>
      <div className="flex flex-col items-start">
        <span className="text-body-bold font-body-bold text-default-font">{title}</span>
        <span className="text-caption font-caption text-subtext-color">{description}</span>
      </div>
    </RadioCardGroup.RadioCard>
  );
}

// Closes only through Done, because the secret cannot be shown again.
function CreatedKeyModal({
  created,
  loginCommand,
  onDone,
}: {
  created: CreatedKey;
  loginCommand: string;
  onDone: () => void;
}) {
  return (
    <Modal wide title="Copy your new token">
      <ModalHeading
        icon={<FeatherKeyRound />}
        tone="success"
        title="Copy your new token"
        description={`${created.name} · ${scopeLabel(created.access === "read-write")} · ${
          created.expiresAt ? `expires ${formatDate(created.expiresAt)}` : "never expires"
        }`}
      />
      <div className="flex w-full flex-col items-start gap-1">
        <span className="text-caption-bold font-caption-bold text-default-font">Personal access token</span>
        <div className="flex w-full items-center gap-2 rounded-md border border-solid border-neutral-border bg-page-background pl-3 pr-1 py-1.5">
          <span className="min-w-[0px] grow shrink-0 basis-0 text-monospace-body font-monospace-body text-default-font break-all">
            {created.key}
          </span>
          <Button variant="brand-secondary" size="small" icon={<FeatherCopy />} onClick={() => void copy(created.key)}>
            Copy
          </Button>
        </div>
      </div>
      <Alert
        variant="warning"
        icon={<FeatherEyeOff />}
        title="You won't see this again"
        description="Store it in your password manager or CI secrets now. If you lose it, revoke it and create a new one."
      />
      <div className="flex w-full flex-col items-start gap-1">
        <span className="text-caption-bold font-caption-bold text-default-font">Log in with Docker</span>
        <div className="flex w-full items-start gap-2 rounded-md border border-solid border-neutral-border bg-page-background pl-3 pr-1 py-1.5">
          <span className="min-w-[0px] grow shrink-0 basis-0 text-monospace-body font-monospace-body text-default-font break-all pt-1">
            {loginCommand}
          </span>
          <CopyButton text={loginCommand} label="Copy login command" />
        </div>
      </div>
      <ModalActions>
        <Button className="mobile:w-full" onClick={onDone}>
          Done
        </Button>
      </ModalActions>
    </Modal>
  );
}

function RevokeModal({ token, onClose }: { token: AccessToken; onClose: () => void }) {
  const queryClient = useQueryClient();
  const name = token.name ?? "Unnamed token";
  const revoke = useMutation({
    mutationFn: async () => unwrap(await authClient.apiKey.delete({ keyId: token.id })),
    onSuccess: async () => {
      await queryClient.invalidateQueries(accessTokensQueryOptions);
      notifySuccess(`${name} revoked`, "Anything using it can no longer sign in.");
      onClose();
    },
    onError: notifyFailure("Couldn't revoke the token"),
  });

  return (
    <ConfirmModal
      icon={<FeatherBan />}
      tone="error"
      title={`Revoke “${name}”?`}
      confirm={{ label: "Revoke token", icon: <FeatherBan /> }}
      destructive
      pending={revoke.isPending}
      onConfirm={() => revoke.mutate()}
      onClose={onClose}
    >
      <div className="flex w-full flex-wrap items-center gap-2 rounded-md bg-page-background px-3 py-2">
        <ScopeBadge write={canWrite(token)} />
        <span className="text-monospace-caption font-monospace-caption text-secondary-font">{prefix(token)}</span>
        <span className="text-caption font-caption text-subtext-color">
          {token.lastRequest ? `last used ${formatRelative(token.lastRequest)}` : "never used"}
        </span>
      </div>
      <Alert
        variant="error"
        icon={<FeatherAlertTriangle />}
        title="Anything using this token stops working immediately"
        description="CI jobs and machines logged in with it will get authentication errors on their next pull or push."
      />
    </ConfirmModal>
  );
}
