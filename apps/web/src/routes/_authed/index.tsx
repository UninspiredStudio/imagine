import { Button } from "@imagine/components/components/Button";
import { IconButton } from "@imagine/components/components/IconButton";
import { Select } from "@imagine/components/components/Select";
import { TextField } from "@imagine/components/components/TextField";
import {
  FeatherArrowRight,
  FeatherArrowUpDown,
  FeatherBox,
  FeatherChevronDown,
  FeatherHardDrive,
  FeatherKeyRound,
  FeatherSearch,
  FeatherSearchX,
  FeatherTag,
  FeatherX,
} from "@subframe/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { CommandLine } from "../../components/Copy";
import { EmptyPanel, LoadError, LoadingRows, PageHeader } from "../../components/Page";
import { VisibilityBadge } from "../../components/VisibilityBadge";
import { metaQueryOptions, repositoriesQueryOptions } from "../../lib/api";
import { formatDateTime, formatRelative, formatSize, plural } from "../../lib/format";

const PAGE_SIZE = 30;

export const Route = createFileRoute("/_authed/")({
  component: ImagesPage,
});

type Repository = Awaited<ReturnType<NonNullable<typeof repositoriesQueryOptions.queryFn>>>[number];

const time = (repository: Repository) => (repository.lastPushedAt ? Date.parse(repository.lastPushedAt) : 0);

// ponytail: the API returns every repository, so search, sort and paging run here. Move them to the server past a few thousand.
function ImagesPage() {
  const { data: repositories, isError, refetch } = useQuery(repositoriesQueryOptions);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("pushed");
  const [limit, setLimit] = useState(PAGE_SIZE);

  if (!repositories) {
    return (
      <>
        <PageHeader title="Images" description="Repositories in this registry" />
        {isError ? <LoadError what="images" onRetry={() => void refetch()} /> : <LoadingRows />}
      </>
    );
  }
  if (repositories.length === 0) return <EmptyRegistry />;

  const term = search.trim().toLowerCase();
  // The API sorts by name, so only the other order needs sorting.
  const matches = repositories.filter((repository) => repository.name.includes(term));
  if (sort === "pushed") matches.sort((a, b) => time(b) - time(a));
  const shown = matches.slice(0, limit);

  function changeSearch(value: string) {
    setSearch(value);
    setLimit(PAGE_SIZE);
  }

  return (
    <>
      <PageHeader
        title="Images"
        description={`${plural(repositories.length, "repository", "repositories")} in this registry`}
      />
      <div className="flex w-full items-center gap-3 mobile:flex-col mobile:items-stretch">
        <TextField
          className="h-auto grow shrink-0 basis-0 mobile:flex-none"
          icon={<FeatherSearch />}
          iconRight={
            search ? (
              <IconButton size="small" icon={<FeatherX />} aria-label="Clear search" onClick={() => changeSearch("")} />
            ) : null
          }
        >
          <TextField.Input
            aria-label="Search repositories"
            placeholder="Search repositories, e.g. team/ or api"
            value={search}
            onChange={(event) => changeSearch(event.target.value)}
          />
        </TextField>
        <Select
          className="h-auto w-52 flex-none mobile:w-full"
          icon={<FeatherArrowUpDown />}
          value={sort}
          onValueChange={setSort}
        >
          <Select.Item value="pushed">Sort: Last pushed</Select.Item>
          <Select.Item value="name">Sort: Name</Select.Item>
        </Select>
      </div>
      {shown.length === 0 ? (
        <EmptyPanel
          icon={<FeatherSearchX />}
          title={`No repositories match “${search.trim()}”`}
          description="Check the spelling, or search part of a path like infra/."
        >
          <Button variant="neutral-secondary" icon={<FeatherX />} onClick={() => changeSearch("")}>
            Clear search
          </Button>
        </EmptyPanel>
      ) : (
        <>
          <div className="w-full items-start gap-4 grid grid-cols-3 mobile:gap-3 mobile:grid-cols-1">
            {shown.map((repository) => (
              <RepositoryCard key={repository.name} repository={repository} />
            ))}
          </div>
          {matches.length > PAGE_SIZE ? (
            <div className="flex w-full flex-col items-center gap-2 pt-2">
              {shown.length < matches.length ? (
                <Button
                  variant="neutral-secondary"
                  icon={<FeatherChevronDown />}
                  onClick={() => setLimit(limit + PAGE_SIZE)}
                >
                  Load more
                </Button>
              ) : null}
              <span className="text-caption font-caption text-subtext-color">
                Showing {shown.length} of {matches.length}
              </span>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

function RepositoryCard({ repository }: { repository: Repository }) {
  const slash = repository.name.lastIndexOf("/") + 1;
  return (
    <Link
      to="/images/$"
      params={{ _splat: repository.name }}
      className="flex min-w-[0px] flex-col items-start gap-4 rounded-lg border border-solid border-neutral-border bg-default-background px-4 py-4 shadow-sm cursor-pointer hover:border-brand-300"
    >
      <div className="flex w-full items-start gap-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-md bg-brand-50">
          <FeatherBox className="text-heading-3 font-heading-3 text-brand-600" />
        </div>
        <div className="flex min-w-[0px] grow shrink-0 basis-0 flex-col items-start justify-center self-stretch">
          {slash > 0 ? (
            <span className="w-full whitespace-nowrap text-monospace-caption font-monospace-caption text-subtext-color truncate">
              {repository.name.slice(0, slash)}
            </span>
          ) : null}
          <span className="w-full whitespace-nowrap text-monospace-body font-monospace-body text-default-font truncate">
            {repository.name.slice(slash)}
          </span>
        </div>
        <VisibilityBadge visibility={repository.visibility} />
      </div>
      <div className="flex w-full items-center gap-4 border-t border-solid border-neutral-border pt-3">
        <div className="flex items-center gap-1.5">
          <FeatherTag className="text-caption font-caption text-subtext-color" />
          <span className="text-caption font-caption text-secondary-font">{plural(repository.tagCount, "tag")}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <FeatherHardDrive className="text-caption font-caption text-subtext-color" />
          <span className="text-caption font-caption text-secondary-font">{formatSize(repository.size)}</span>
        </div>
        <span
          className="text-caption font-caption text-subtext-color text-right grow"
          title={repository.lastPushedAt ? formatDateTime(repository.lastPushedAt) : undefined}
        >
          {repository.lastPushedAt ? formatRelative(repository.lastPushedAt) : "Never pushed"}
        </span>
      </div>
    </Link>
  );
}

function EmptyRegistry() {
  const { data: meta } = useQuery(metaQueryOptions);
  const navigate = useNavigate();
  const host = meta?.host ?? "";
  const steps = [
    {
      title: "Log in",
      hint: "Username: your email. Password: an API key.",
      command: `docker login ${host}`,
    },
    { title: "Tag your image", command: `docker tag my-image ${host}/my-image:latest` },
    { title: "Push", command: `docker push ${host}/my-image:latest` },
  ];

  return (
    <>
      <PageHeader title="Images" description="No repositories yet" />
      <div className="flex w-full flex-col items-center rounded-lg border border-dashed border-neutral-border bg-page-background px-6 py-12 mobile:px-4 mobile:py-8">
        <div className="flex w-full max-w-[640px] flex-col items-start gap-6">
          <div className="flex flex-col items-start gap-3">
            <div className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-brand-50">
              <FeatherBox className="text-heading-2 font-heading-2 text-brand-600" />
            </div>
            <div className="flex flex-col items-start gap-1">
              <h2 className="text-heading-2 font-heading-2 text-default-font">Push your first image</h2>
              <span className="text-body font-body text-subtext-color">
                This registry is empty. Run these three commands from any machine with Docker.
              </span>
            </div>
          </div>
          {steps.map((step, index) => (
            <div key={step.title} className="flex w-full flex-col items-start gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-brand-100">
                  <span className="text-caption-bold font-caption-bold text-brand-800">{index + 1}</span>
                </div>
                <span className="text-body-bold font-body-bold text-default-font">{step.title}</span>
                {step.hint ? (
                  <span className="text-caption font-caption text-subtext-color">{step.hint}</span>
                ) : null}
              </div>
              <CommandLine command={step.command} />
            </div>
          ))}
          <div className="flex w-full items-center gap-3 rounded-md bg-brand-50 px-4 py-3 mobile:flex-col mobile:items-start">
            <FeatherKeyRound className="text-heading-3 font-heading-3 text-brand-600" />
            <div className="flex grow shrink-0 basis-0 flex-col items-start">
              <span className="text-body-bold font-body-bold text-default-font">You need an API key to push</span>
              <span className="text-caption font-caption text-secondary-font">
                Create one with Read and write scope and use it as the password.
              </span>
            </div>
            <Button iconRight={<FeatherArrowRight />} onClick={() => navigate({ to: "/api-keys" })}>
              Create API key
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
