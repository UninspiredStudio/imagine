import { Alert } from "@imagine/components/components/Alert";
import { Breadcrumbs } from "@imagine/components/components/Breadcrumbs";
import { Button } from "@imagine/components/components/Button";
import { IconButton } from "@imagine/components/components/IconButton";
import { Select } from "@imagine/components/components/Select";
import { TextField } from "@imagine/components/components/TextField";
import {
  FeatherAlertTriangle,
  FeatherArrowLeft,
  FeatherArrowUpDown,
  FeatherChevronDown,
  FeatherChevronLeft,
  FeatherChevronRight,
  FeatherGlobe,
  FeatherLock,
  FeatherPackageX,
  FeatherSearch,
  FeatherSearchX,
  FeatherTag,
  FeatherTrash2,
  FeatherX,
} from "@subframe/core";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { CommandLine, CopyButton } from "../../components/Copy";
import { ConfirmModal } from "../../components/Modal";
import { EmptyPanel, LoadError, LoadingRows, PageMessage, SectionHeading } from "../../components/Page";
import { VisibilityBadge } from "../../components/VisibilityBadge";
import {
  apiClient,
  apiError,
  isAdmin,
  metaQueryOptions,
  platformsQueryOptions,
  repositoriesQueryOptions,
  tagsQueryOptions,
} from "../../lib/api";
import { formatDate, formatDateTime, formatRelative, formatSize, plural, shortDigest } from "../../lib/format";
import { notifyFailure, notifySuccess } from "../../lib/notify";

const PAGE_SIZE = 25;

// A splat, because repository names contain slashes.
export const Route = createFileRoute("/_authed/images/$")({
  component: ImageRoute,
});

function ImageRoute() {
  const { _splat: name = "" } = Route.useParams();
  // Keyed, so search and paging start fresh for another repository.
  return <ImagePage key={name} name={name} />;
}

function ImagePage({ name }: { name: string }) {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();
  const { data: meta } = useQuery(metaQueryOptions);
  const repositories = useQuery(repositoriesQueryOptions);
  const [dialog, setDialog] = useState<"visibility" | "delete" | null>(null);
  const repository = repositories.data?.find((candidate) => candidate.name === name);
  const reference = `${meta?.host ?? ""}/${name}`;

  const breadcrumbs = (
    <Breadcrumbs className="pb-1">
      <Link to="/">
        <Breadcrumbs.Item>Images</Breadcrumbs.Item>
      </Link>
      <Breadcrumbs.Divider />
      <Breadcrumbs.Item className="text-monospace-body font-monospace-body" active={true}>
        {name}
      </Breadcrumbs.Item>
    </Breadcrumbs>
  );

  if (!repository) {
    return (
      <>
        {breadcrumbs}
        {repositories.isPending ? (
          <LoadingRows />
        ) : repositories.isError ? (
          <LoadError what="this image" onRetry={() => void repositories.refetch()} />
        ) : (
          <PageMessage
            icon={<FeatherPackageX />}
            title="Repository not found"
            detail={name}
            description="It may have been deleted, or the name is wrong."
          >
            <Button variant="neutral-secondary" icon={<FeatherArrowLeft />} onClick={() => navigate({ to: "/" })}>
              Back to Images
            </Button>
          </PageMessage>
        )}
      </>
    );
  }

  const isPublic = repository.visibility === "public";
  const canEdit = isAdmin(user);
  return (
    <>
      <div className="flex w-full items-end justify-between gap-6 mobile:flex-col mobile:items-start mobile:justify-start mobile:gap-3">
        <div className="flex min-w-[0px] flex-col items-start gap-1">
          {breadcrumbs}
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-monospace-heading font-monospace-heading text-default-font break-all">{name}</h1>
            <VisibilityBadge visibility={repository.visibility} />
          </div>
          <div className="flex max-w-full items-center gap-1 rounded-md bg-page-background pl-2.5 pr-1 py-0.5">
            <span className="text-monospace-caption font-monospace-caption text-secondary-font break-all">
              {reference}
            </span>
            <CopyButton text={reference} label="Copy image reference" />
          </div>
        </div>
        {canEdit ? (
          <div className="flex items-center gap-2">
            <Button
              variant="neutral-secondary"
              icon={isPublic ? <FeatherLock /> : <FeatherGlobe />}
              onClick={() => setDialog("visibility")}
            >
              {isPublic ? "Make private" : "Make public"}
            </Button>
            <Button variant="destructive-secondary" icon={<FeatherTrash2 />} onClick={() => setDialog("delete")}>
              Delete image
            </Button>
          </div>
        ) : null}
      </div>
      <div className="w-full items-start gap-px overflow-hidden rounded-lg border border-solid border-neutral-border bg-neutral-border grid grid-cols-4 mobile:grid-cols-2">
        <Stat label="Tags" value={String(repository.tagCount)} />
        <Stat label="Total size" value={formatSize(repository.size)} />
        <Stat
          label="Created"
          value={formatDate(repository.createdAt)}
          title={formatDateTime(repository.createdAt)}
        />
        <Stat
          label="Last pushed"
          value={repository.lastPushedAt ? formatRelative(repository.lastPushedAt) : "Never"}
          title={repository.lastPushedAt ? formatDateTime(repository.lastPushedAt) : undefined}
        />
      </div>
      <Tags name={name} reference={reference} canEdit={canEdit} />
      {dialog === "delete" ? (
        <DeleteImageModal name={name} tagCount={repository.tagCount} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "visibility" ? (
        <VisibilityModal
          name={name}
          host={meta?.host ?? ""}
          makePublic={!isPublic}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex flex-col items-start gap-1 self-stretch bg-default-background px-4 py-3">
      <span className="text-caption font-caption text-subtext-color">{label}</span>
      <span className="text-heading-3 font-heading-3 text-default-font" title={title}>
        {value}
      </span>
    </div>
  );
}

function VisibilityModal({
  name,
  host,
  makePublic,
  onClose,
}: {
  name: string;
  host: string;
  makePublic: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: async () => {
      const res = await apiClient.api.repositories.visibility.$patch({
        json: { name, visibility: makePublic ? "public" : "private" },
      });
      if (!res.ok) throw await apiError(res);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries(repositoriesQueryOptions);
      notifySuccess(
        `${name} is now ${makePublic ? "public" : "private"}`,
        makePublic ? "Anyone can pull it without credentials." : "Pulls need a personal access token.",
      );
      onClose();
    },
    onError: notifyFailure("Couldn't change visibility"),
  });

  if (makePublic) {
    return (
      <ConfirmModal
        icon={<FeatherGlobe />}
        tone="success"
        title={`Make ${name} public?`}
        description={`Anyone who can reach ${host} will be able to pull this image without credentials.`}
        confirm={{ label: "Make public", icon: <FeatherGlobe /> }}
        pending={change.isPending}
        onConfirm={() => change.mutate()}
        onClose={onClose}
      >
        <div className="flex w-full flex-col items-start gap-2">
          <div className="flex w-full flex-col items-start gap-1 rounded-md bg-page-background px-3 py-2">
            <span className="text-monospace-caption font-monospace-caption text-default-font break-all">
              docker pull {host}/{name}
            </span>
            <span className="text-caption font-caption text-subtext-color">will work without docker login</span>
          </div>
          <span className="text-caption font-caption text-subtext-color">Pushing still requires a personal access token.</span>
        </div>
      </ConfirmModal>
    );
  }
  return (
    <ConfirmModal
      icon={<FeatherLock />}
      tone="neutral"
      title={`Make ${name} private?`}
      description="Pulls will need a personal access token. Anyone pulling anonymously — CI jobs, servers, other teams — will start getting authentication errors."
      confirm={{ label: "Make private", icon: <FeatherLock /> }}
      pending={change.isPending}
      onConfirm={() => change.mutate()}
      onClose={onClose}
    >
      <Alert
        variant="warning"
        icon={<FeatherAlertTriangle />}
        title="Anonymous pulls will fail"
        description="Check nothing depends on pulling this image without credentials."
      />
    </ConfirmModal>
  );
}

function DeleteImageModal({ name, tagCount, onClose }: { name: string; tagCount: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const remove = useMutation({
    mutationFn: async () => {
      const res = await apiClient.api.repositories.$delete({ query: { name } });
      if (!res.ok) throw await apiError(res);
      return res.json();
    },
    onSuccess: async (removed) => {
      // Leaves first, so the refreshed list doesn't show "Repository not found" here.
      await navigate({ to: "/" });
      queryClient.removeQueries({ queryKey: tagsQueryOptions(name).queryKey });
      notifySuccess(
        `${name} was deleted`,
        `${plural(removed.tagCount, "tag")} removed. Storage is freed later by the cleanup sweep.`,
      );
    },
    onError: notifyFailure("Couldn't delete the image"),
    onSettled: () => queryClient.invalidateQueries(repositoriesQueryOptions),
  });

  return (
    <ConfirmModal
      icon={<FeatherTrash2 />}
      tone="error"
      title={`Delete ${name}?`}
      description={`This deletes the repository with ${
        tagCount === 0 ? "its untagged manifests" : tagCount === 1 ? "its tag and manifests" : `all ${tagCount} tags and their manifests`
      }. This can't be undone.`}
      confirm={{ label: "Delete image", icon: <FeatherTrash2 /> }}
      destructive
      pending={remove.isPending}
      blocked={typed !== name}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    >
      <span className="text-caption font-caption text-subtext-color">
        Storage is freed later by the cleanup sweep.
      </span>
      <TextField className="h-auto w-full flex-none" label={`Type ${name} to confirm`}>
        <TextField.Input
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && typed === name && !remove.isPending) remove.mutate();
          }}
        />
      </TextField>
    </ConfirmModal>
  );
}

type TagRow = { tag: string; digest: string };

function DeleteTagModal({
  name,
  tag,
  others,
  onClose,
}: {
  name: string;
  tag: TagRow;
  others: string[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: async () => {
      const res = await apiClient.api.repositories.tags.$delete({ query: { name, tag: tag.tag } });
      if (!res.ok) throw await apiError(res);
    },
    onSuccess: () => {
      notifySuccess(`Tag ${tag.tag} was deleted`);
      onClose();
    },
    onError: notifyFailure("Couldn't delete the tag"),
    onSettled: async () => {
      await queryClient.invalidateQueries(tagsQueryOptions(name));
      await queryClient.invalidateQueries(repositoriesQueryOptions);
    },
  });

  return (
    <ConfirmModal
      icon={<FeatherTrash2 />}
      tone="error"
      title={`Delete tag ${tag.tag}?`}
      description={
        others.length > 0
          ? "The tag is removed. The image itself stays, because another tag still points to it."
          : "No other tag points to this image, so it becomes untagged."
      }
      confirm={{ label: "Delete tag", icon: <FeatherTrash2 /> }}
      destructive
      pending={remove.isPending}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    >
      {others.length > 0 ? (
        <div className="flex w-full flex-col items-start gap-1 rounded-md bg-page-background px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-caption font-caption text-subtext-color">Still tagged as</span>
            {others.slice(0, 5).map((other) => (
              <span
                key={other}
                className="rounded-sm bg-neutral-200 px-1.5 py-0.5 text-monospace-caption font-monospace-caption text-default-font break-all"
              >
                {other}
              </span>
            ))}
            {others.length > 5 ? (
              <span className="text-caption font-caption text-subtext-color">and {others.length - 5} more</span>
            ) : null}
          </div>
          <span className="text-monospace-caption font-monospace-caption text-secondary-font">
            {shortDigest(tag.digest)}
          </span>
        </div>
      ) : (
        <Alert
          variant="warning"
          icon={<FeatherAlertTriangle />}
          title={`${shortDigest(tag.digest)} will be untagged`}
          description="It can then only be pulled by digest, and keeps its storage until the whole image is deleted."
        />
      )}
    </ConfirmModal>
  );
}

// ponytail: the API returns every tag, so search, sort and paging run here. Move them to the server if that gets slow.
function Tags({ name, reference, canEdit }: { name: string; reference: string; canEdit: boolean }) {
  const { data: tags, isError, refetch } = useQuery(tagsQueryOptions(name));
  const [deleting, setDeleting] = useState<TagRow | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const matches = (tags ?? []).filter((tag) => tag.tag.toLowerCase().includes(search.trim().toLowerCase()));
  // The API sorts by name, so only the other order needs sorting.
  if (sort === "newest") matches.sort((a, b) => Date.parse(b.pushedAt) - Date.parse(a.pushedAt));
  // A refetch can shorten the list under the current page.
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  const current = Math.min(page, lastPage);
  const start = current * PAGE_SIZE;
  const shown = matches.slice(start, start + PAGE_SIZE);
  const { data: platforms } = useQuery({
    ...platformsQueryOptions(name, [...new Set(shown.map((tag) => tag.digest))].sort()),
    placeholderData: keepPreviousData,
  });

  if (!tags) {
    return (
      <div className="flex w-full flex-col items-start gap-3 pt-2">
        <SectionHeading title="Tags" />
        {isError ? <LoadError what="tags" onRetry={() => void refetch()} /> : <LoadingRows />}
      </div>
    );
  }
  if (tags.length === 0) {
    return (
      <div className="flex w-full flex-col items-start gap-3 pt-2">
        <SectionHeading title="Tags" count={0} />
        <EmptyPanel
          icon={<FeatherTag />}
          title="No tags in this repository"
          description="Only untagged manifests remain, if any. Push a new tag to use this repository again."
        >
          <div className="flex w-full max-w-[520px]">
            <CommandLine command={`docker push ${reference}:latest`} />
          </div>
        </EmptyPanel>
      </div>
    );
  }

  const tagsByDigest = Map.groupBy(tags, (tag) => tag.digest);
  const othersOf = (tag: TagRow) =>
    (tagsByDigest.get(tag.digest) ?? []).map((other) => other.tag).filter((other) => other !== tag.tag);

  function changeSearch(value: string) {
    setSearch(value);
    setPage(0);
  }

  return (
    <div className="flex w-full flex-col items-start gap-3 pt-2">
      <div className="flex w-full items-center gap-3 mobile:flex-col mobile:items-stretch">
        <SectionHeading title="Tags" count={tags.length} />
        <TextField className="h-auto w-64 flex-none mobile:w-full" icon={<FeatherSearch />}>
          <TextField.Input
            aria-label="Search tags"
            placeholder="Search tags"
            value={search}
            onChange={(event) => changeSearch(event.target.value)}
          />
        </TextField>
        <Select
          className="h-auto w-48 flex-none mobile:w-full"
          icon={<FeatherArrowUpDown />}
          value={sort}
          onValueChange={(value) => {
            setSort(value);
            setPage(0);
          }}
        >
          <Select.Item value="newest">Sort: Newest first</Select.Item>
          <Select.Item value="name">Sort: Name</Select.Item>
        </Select>
      </div>
      {shown.length === 0 ? (
        <EmptyPanel
          icon={<FeatherSearchX />}
          title={`No tags match “${search.trim()}”`}
          description="Check the spelling, or search part of a tag."
        >
          <Button variant="neutral-secondary" icon={<FeatherX />} onClick={() => changeSearch("")}>
            Clear search
          </Button>
        </EmptyPanel>
      ) : (
        <>
          <div className="flex w-full flex-col items-start overflow-hidden rounded-lg border border-solid border-neutral-border bg-default-background">
            <div className="flex w-full items-center gap-4 border-b border-solid border-neutral-border bg-page-background px-4 py-2 mobile:hidden">
              <span className="grow shrink-0 basis-0 text-caption-bold font-caption-bold text-subtext-color">Tag</span>
              <span className="w-44 flex-none text-caption-bold font-caption-bold text-subtext-color">Digest</span>
              <span className="w-56 flex-none text-caption-bold font-caption-bold text-subtext-color">Platforms</span>
              <span className="w-20 flex-none text-caption-bold font-caption-bold text-subtext-color text-right">
                Size
              </span>
              <span className="w-28 flex-none text-caption-bold font-caption-bold text-subtext-color text-right">
                Pushed
              </span>
              {canEdit ? <div className="flex w-16 flex-none items-start" /> : null}
            </div>
            {shown.map((tag, index) => {
              const open = expanded === tag.tag;
              const others = othersOf(tag);
              const tagPlatforms = platforms?.[tag.digest] ?? [];
              const toggle = () => setExpanded(open ? null : tag.tag);
              return (
                <div
                  key={tag.tag}
                  className={`flex w-full flex-col items-start ${
                    index < shown.length - 1 ? "border-b border-solid border-neutral-border" : ""
                  } ${open ? "bg-brand-50" : "hover:bg-neutral-50"}`}
                >
                  <div className="flex w-full items-center gap-4 px-4 py-3 cursor-pointer" onClick={toggle}>
                    <button
                      type="button"
                      aria-expanded={open}
                      className="flex min-w-[0px] grow shrink-0 basis-0 items-center gap-2 text-left"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle();
                      }}
                    >
                      {open ? (
                        <FeatherChevronDown className="flex-none text-body font-body text-subtext-color" />
                      ) : (
                        <FeatherChevronRight className="flex-none text-body font-body text-subtext-color" />
                      )}
                      <span className="flex min-w-[0px] flex-col items-start">
                        <span className="text-monospace-body font-monospace-body text-default-font break-all">
                          {tag.tag}
                        </span>
                        {others.length > 0 ? (
                          <span className="text-caption font-caption text-subtext-color break-all">
                            also tagged: {others.slice(0, 5).join(", ")}
                            {others.length > 5 ? ` and ${others.length - 5} more` : ""}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    <div className="flex w-44 flex-none items-center gap-1 mobile:hidden">
                      <span
                        className="text-monospace-caption font-monospace-caption text-secondary-font"
                        title={tag.digest}
                      >
                        {shortDigest(tag.digest)}
                      </span>
                      <CopyButton text={tag.digest} label="Copy digest" />
                    </div>
                    <div className="flex w-56 flex-none flex-wrap items-center gap-1 mobile:hidden">
                      {tagPlatforms.map((platform) => (
                        <span
                          key={platform}
                          className="rounded-sm bg-neutral-100 px-1.5 py-0.5 text-monospace-caption font-monospace-caption text-secondary-font"
                        >
                          {platform}
                        </span>
                      ))}
                    </div>
                    <span className="w-20 flex-none text-body font-body text-secondary-font text-right mobile:hidden">
                      {formatSize(tag.size)}
                    </span>
                    <span
                      className="w-28 flex-none text-body font-body text-secondary-font text-right"
                      title={formatDateTime(tag.pushedAt)}
                    >
                      {formatRelative(tag.pushedAt)}
                    </span>
                    {canEdit ? (
                      <div className="flex w-16 flex-none items-center justify-end mobile:w-auto">
                        <IconButton
                          variant="destructive-tertiary"
                          size="small"
                          icon={<FeatherTrash2 />}
                          aria-label={`Delete tag ${tag.tag}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setDeleting(tag);
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                  {open ? (
                    <div className="flex w-full flex-col items-start gap-3 pl-10 pr-4 pb-4 mobile:pl-4">
                      <PullCommand label="Pull by tag" command={`docker pull ${reference}:${tag.tag}`} />
                      <PullCommand label="Pull by digest" command={`docker pull ${reference}@${tag.digest}`} />
                      <div className="flex w-full flex-wrap items-center gap-x-6 gap-y-1">
                        <span className="text-caption font-caption text-subtext-color">
                          Pushed {formatDateTime(tag.pushedAt)}
                        </span>
                        <span className="text-caption font-caption text-subtext-color">
                          {/index|manifest\.list/.test(tag.mediaType) ? "Image index" : "Image manifest"}
                          {tagPlatforms.length > 0 ? ` · ${plural(tagPlatforms.length, "platform")}` : ""}
                        </span>
                        {/* The size and platform columns are hidden on mobile. */}
                        <span className="hidden text-caption font-caption text-subtext-color mobile:inline">
                          {[formatSize(tag.size), ...tagPlatforms].join(" · ")}
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="flex w-full items-center justify-between gap-4">
            <span className="text-caption font-caption text-subtext-color">
              Showing {start + 1}–{start + shown.length} of {matches.length}
            </span>
            {lastPage > 0 ? (
              <div className="flex items-center gap-2">
                <Button
                  disabled={current === 0}
                  variant="neutral-secondary"
                  size="small"
                  icon={<FeatherChevronLeft />}
                  onClick={() => setPage(current - 1)}
                >
                  Previous
                </Button>
                <Button
                  disabled={current === lastPage}
                  variant="neutral-secondary"
                  size="small"
                  iconRight={<FeatherChevronRight />}
                  onClick={() => setPage(current + 1)}
                >
                  Next
                </Button>
              </div>
            ) : null}
          </div>
        </>
      )}
      {deleting ? (
        <DeleteTagModal
          name={name}
          tag={deleting}
          others={othersOf(deleting)}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}

function PullCommand({ label, command }: { label: string; command: string }) {
  return (
    <div className="flex w-full flex-col items-start gap-1">
      <span className="text-caption-bold font-caption-bold text-secondary-font">{label}</span>
      <CommandLine command={command} />
    </div>
  );
}
