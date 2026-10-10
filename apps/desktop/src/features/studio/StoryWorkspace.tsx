import { StoryOptionsButton } from './StoryOptionsPanel';
import { useAssistant } from '@/assistant/runtime';
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { nanoid } from "nanoid";
import {
  anchorState,
  narrativeOrder,
  storyImpact,
  worldTimeline,
  type StoryGraph,
  type StoryNode,
  type ScenePlan,
} from "@the-water/shared";
import { Button, Input, Select, cn } from "@/components/ui";
import { AsyncNotice } from "@/components/data/AsyncNotice";
import { useAsyncData } from "@/components/data/useAsyncData";
import { toast } from "@/components/Toast";
import { t } from "@/i18n";
import { useJobs } from "@/stores/jobsStore";
import type { Novel } from "@/db/repos/novelsRepo";
import { getVersion, upsertChapterPlan } from "@/db/repos/chaptersRepo";
import { saveWritingCard } from "@/db/repos/writingRepo";
import {
  editStoryScene,
  editStoryBeat,
  listStoryChanges,
  loadStoryWorkspace,
  makeStoryAnchor,
  saveStoryGraph,
  undoStoryChange,
  type StoryWorkspace as Workspace,
} from "@/db/repos/storyGraphRepo";
import { ChaptersTab } from "./ChaptersTab";
import {
  StoryControlPanels,
  StoryCandidates,
  StoryBranchPanel,
} from "./StoryWorkspacePanels";
import { createMandate, runMandate } from "@/novel/storyMandates";
import { readStoryProse } from "@/novel/storyIntelligence";
import { storyMapLayout, storyWorkspacePanels } from "./storyWorkspaceLayout";

function usePaneWidth() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width] as const;
}

export type StoryAction = (
  fn: (signal: AbortSignal) => Promise<unknown>,
) => Promise<void>;
export function StoryField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="my-3 block text-xs text-ink-600 dark:text-ink-300">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
    </label>
  );
}
export function StoryArea({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (text: string) => void;
  label: string;
}) {
  return (
    <StoryField label={label}>
      <textarea
        aria-label={label}
        className="min-h-20 w-full rounded-lg border border-paper-300 bg-transparent p-2 text-sm dark:border-paper-700"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </StoryField>
  );
}
export function NodeSelect({
  w,
  value,
  onChange,
  label,
  empty = true,
}: {
  w: Workspace;
  value: string;
  onChange: (value: string) => void;
  label: string;
  empty?: boolean;
}) {
  return (
    <StoryField label={label}>
      <Select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {empty && <option value="">{t.storyWorkspace.unknown}</option>}
        {narrativeOrder(w.nodes).map((n) => (
          <option key={n.id} value={n.id}>
            {n.chapterNo ?? "—"} · {n.title || t.storyWorkspace[n.kind]}
          </option>
        ))}
      </Select>
    </StoryField>
  );
}
const modes = [
  "map",
  "timeline",
  "split",
  "text",
  "controls",
  "candidates",
  "branches",
  "inbox",
  "voice",
  "resume",
] as const;
type Mode = (typeof modes)[number];
export function StoryWorkspace({ novel }: { novel: Novel }) {
  const [workspaceRef, workspaceWidth] = usePaneWidth();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<Mode>("map"),
    [query, setQuery] = useState(""),
    [character, setCharacter] = useState(""),
    [group, setGroup] = useState("");
  const [page, setPage] = useState(0),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0),
    [stream, setStream] = useState(""),
    [overview, setOverview] = useState(true);
  const ac = useRef<AbortController | null>(null);
  useEffect(() => () => ac.current?.abort(), []);
  const jobTick = useJobs((s) => s.novelTick[novel.id] ?? 0);
  const {
    data: w,
    error,
    reload,
  } = useAsyncData(() => loadStoryWorkspace(novel.id), {
    key: `story-workspace:${novel.id}:${jobTick}:${tick}`,
  });
  const { data: history } = useAsyncData(() => listStoryChanges(novel.id), {
    key: `story-history:${novel.id}:${jobTick}:${tick}`,
  });
  const act: StoryAction = async (fn) => {
    if (ac.current) return;
    const controller = new AbortController();
    ac.current = controller;
    setBusy(true);
    try {
      await fn(controller.signal);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      ac.current = null;
      setBusy(false);
      setTick((n) => n + 1);
    }
  };
  const selectedId = params.get("node") ?? "";
  const panels = storyWorkspacePanels(workspaceWidth, mode === "split");
  const selected = w?.nodes.find((n) => n.id === selectedId);
  useEffect(()=>{useAssistant.getState().setContext({novelId:novel.id,chapterId:selected?.chapterId??null,objectIds:selectedId?[selectedId]:[],selection:null});},[novel.id,selectedId,selected?.chapterId]);
  const pick = (node: StoryNode) => {
    setNavigationOpen(false);
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("node", node.id);
        if (node.chapterId) next.set("chapter", node.chapterId);
        return next;
      },
      { replace: true },
    );
  };
  useEffect(() => {
    setNavigationOpen(false);
    setInspectorOpen(false);
  }, [mode]);
  useEffect(() => {
    setPage(0);
  }, [query, character, group]);
  if (!w || error) return <AsyncNotice error={error} retry={reload} />;
  const filtered = narrativeOrder(w.nodes).filter(
    (n) =>
      (!query ||
        n.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) &&
      (!character || n.characterIds.includes(character)) &&
      (!group || n.volumeId === group || n.arcId === group),
  );
  const nodes = filtered.slice(page * 48, (page + 1) * 48);
  const saveGraph = (graph: StoryGraph, label: string) =>
    act(() => saveStoryGraph(novel.id, w.revision, graph, label));
  const addScene = () =>
    act(async () => {
      let chapter =
        w.chapters.find((c) => c.id === selected?.chapterId) ??
        w.chapters.at(-1);
      if (!chapter)
        chapter = await upsertChapterPlan(novel.id, {
          chapterNo: 1,
          title: "",
          targetChars: 1000,
        });
      const data: ScenePlan = {
        title: "",
        volumeId: null,
        povCharacterId: null,
        time: "",
        location: "",
        characterIds: [],
        goal: "",
        obstacle: "",
        turn: "",
        outcome: "",
        targetChars: 1000,
        dependencyIds: [],
        threadIds: [],
      };
      const id = await saveWritingCard(
        novel.id,
        { kind: "scene", data },
        { chapterId: chapter.id, order: w.cards.length, confirmed: true },
      );
      setParams((previous) => {
        const next = new URLSearchParams(previous);
        next.set("node", id);
        next.set("chapter", chapter.id);
        return next;
      });
    });
  const visibleIds = new Set(filtered.map((n) => n.id));
  const fullTimeline = worldTimeline(w.nodes, w.graph);
  const timeline = {
    layers: fullTimeline.layers
      .map((layer) => layer.filter((n) => visibleIds.has(n.id)))
      .filter((layer) => layer.length),
    cycles: fullTimeline.cycles.filter((id) => visibleIds.has(id)),
  };
  const latestChange = history?.find((c) => !c.undone);
  return (
    <div
      ref={workspaceRef}
      className="flex h-full min-h-0 min-w-0 flex-col"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setNavigationOpen(false);
          setInspectorOpen(false);
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-paper-300 p-3 dark:border-paper-800">
        <h2 className="mr-3 font-semibold">{t.storyWorkspace.title}</h2>
        {selected?.kind === 'scene' && <StoryOptionsButton novel={novel} scope={{ kind: 'scene', id: selected.id }} onChanged={reload} />}
        {(selected?.arcId || w.arcs.some(a => a.id === group)) && <StoryOptionsButton novel={novel} scope={{ kind: 'arc', id: selected?.arcId || group }} onChanged={reload} />}
        {mode !== "text" && !panels.navigationInline && (
          <Button
            size="sm"
            variant={navigationOpen ? "primary" : "secondary"}
            aria-expanded={navigationOpen}
            aria-controls="story-navigation"
            onClick={() => {
              setNavigationOpen((v) => !v);
              setInspectorOpen(false);
            }}
          >
            {t.storyWorkspace.navigation}
          </Button>
        )}
        {mode !== "text" && !panels.inspectorInline && (
          <Button
            size="sm"
            disabled={!selected}
            variant={inspectorOpen ? "primary" : "secondary"}
            aria-expanded={inspectorOpen}
            aria-controls="story-inspector"
            onClick={() => {
              setInspectorOpen((v) => !v);
              setNavigationOpen(false);
            }}
          >
            {t.storyWorkspace.inspector}
          </Button>
        )}
        <nav
          className="flex flex-wrap gap-1"
          aria-label={t.storyWorkspace.title}
        >
          {modes.map((m) => (
            <Button
              size="sm"
              key={m}
              variant={mode === m ? "primary" : "ghost"}
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
            >
              {t.storyWorkspace[m]}
            </Button>
          ))}
        </nav>
        {busy && (
          <Button size="sm" onClick={() => ac.current?.abort()}>
            {t.studio.workbench.cancel}
          </Button>
        )}
        <Button
          size="sm"
          disabled={busy || !latestChange}
          onClick={() => act(() => undoStoryChange(novel.id, latestChange!.id))}
        >
          {t.storyWorkspace.undo}
        </Button>
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {mode !== "text" &&
          ((navigationOpen && !panels.navigationInline) ||
            (inspectorOpen && !panels.inspectorInline)) && (
            <button
              aria-label={t.common.close}
              className="absolute inset-0 z-10 bg-black/20"
              onClick={() => {
                setNavigationOpen(false);
                setInspectorOpen(false);
              }}
            />
          )}
        <aside
          id="story-navigation"
          className={cn(
            "w-52 shrink-0 overflow-y-auto border-r border-paper-300 bg-paper-50 p-3 dark:border-paper-800 dark:bg-paper-950",
            !panels.navigationInline &&
              "absolute inset-y-0 left-0 z-20 shadow-xl",
            !panels.navigationInline && !navigationOpen && "hidden",
            mode === "text" && "hidden",
          )}
        >
          <Input
            aria-label={t.storyWorkspace.search}
            placeholder={t.storyWorkspace.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <StoryField label={t.storyWorkspace.character}>
            <Select
              value={character}
              onChange={(e) => setCharacter(e.target.value)}
            >
              <option value="">{t.storyWorkspace.all}</option>
              {w.characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </StoryField>
          <StoryField label={t.storyWorkspace.group}>
            <Select value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">{t.storyWorkspace.all}</option>
              {w.cards.flatMap((c) =>
                c.kind === "volume"
                  ? [
                      <option key={c.id} value={c.id}>
                        {c.data.title}
                      </option>,
                    ]
                  : [],
              )}
              {w.arcs.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </Select>
          </StoryField>
          <Button size="sm" disabled={busy} onClick={addScene}>
            {t.storyWorkspace.newScene}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || w.chapters.length >= 500}
            onClick={() =>
              act(() =>
                upsertChapterPlan(novel.id, {
                  chapterNo: (w.chapters.at(-1)?.chapterNo ?? 0) + 1,
                  title: "",
                  targetChars: 1000,
                }),
              )
            }
          >
            {t.storyWorkspace.newChapter}
          </Button>
          <div className="mt-4 space-y-2">
            {w.chapters.map((ch) => {
              const items = filtered.filter((n) => n.chapterId === ch.id);
              if (!items.length) return null;
              return (
                <details
                  key={ch.id}
                  open={w.nodes.length < 30 || selected?.chapterId === ch.id}
                >
                  <summary className="cursor-pointer text-sm">
                    {ch.chapterNo} · {ch.title || t.storyWorkspace.chapter}{" "}
                    <span className="text-ink-400">({items.length})</span>
                  </summary>
                  {items.map((n) => (
                    <button
                      key={n.id}
                      className={cn(
                        "my-1 block w-full rounded p-2 text-left text-xs",
                        selectedId === n.id
                          ? "bg-paper-200 dark:bg-paper-800"
                          : "hover:bg-paper-100 dark:hover:bg-paper-900",
                      )}
                      onClick={() => pick(n)}
                    >
                      {n.title || t.storyWorkspace[n.kind]}
                    </button>
                  ))}
                </details>
              );
            })}
          </div>
        </aside>
        <main
          className={cn(
            "min-w-0 flex-1",
            mode === "split" ? "overflow-hidden" : "overflow-auto",
          )}
          aria-busy={busy}
        >
          {!w.nodes.length && mode !== "text" && (
            <p className="p-8 text-sm text-ink-500">{t.storyWorkspace.empty}</p>
          )}
          {(mode === "map" || mode === "split") && (
            <div
              className={cn(
                mode === "split" ? "grid h-full min-h-0" : "h-full min-h-0",
                mode === "split" &&
                  selected?.chapterId &&
                  (panels.splitColumns
                    ? "grid-cols-[minmax(220px,0.8fr)_minmax(360px,1.2fr)]"
                    : "grid-rows-2"),
              )}
            >
              <div className="flex h-full min-h-0 min-w-0 flex-col p-4">
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 self-start"
                  onClick={() => setOverview((v) => !v)}
                >
                  {overview
                    ? t.storyWorkspace.expand
                    : t.storyWorkspace.collapse}{" "}
                  · {t.storyWorkspace.group}
                </Button>
                <div className="min-h-0 flex-1 overflow-auto">
                  {overview &&
                  !group &&
                  (w.arcs.length > 0 ||
                    w.cards.some((c) => c.kind === "volume")) ? (
                    <div
                      className="my-4 grid gap-4"
                      style={{
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
                      }}
                    >
                      {[
                        ...w.cards.flatMap((c) =>
                          c.kind === "volume"
                            ? [{ id: c.id, title: c.data.title }]
                            : [],
                        ),
                        ...w.arcs,
                      ].map((g) => (
                        <button
                          key={g.id}
                          className="rounded-xl border border-paper-300 bg-paper-0 p-5 text-left dark:bg-paper-900"
                          onClick={() => {
                            setGroup(g.id);
                            setOverview(false);
                          }}
                        >
                          <strong className="block">{g.title}</strong>
                          <span className="text-sm text-ink-500">
                            {
                              filtered.filter(
                                (n) => n.volumeId === g.id || n.arcId === g.id,
                              ).length
                            }{" "}
                            · {t.storyWorkspace.scene}
                          </span>
                        </button>
                      ))}
                      <Button onClick={() => setOverview(false)}>
                        {t.storyWorkspace.all} ({filtered.length})
                      </Button>
                    </div>
                  ) : (
                    <StoryMap
                      nodes={nodes}
                      graph={w.graph}
                      selectedId={selectedId}
                      onPick={pick}
                    />
                  )}
                </div>
                <div className="mt-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
                  <Button
                    size="sm"
                    disabled={page === 0}
                    onClick={() => setPage((n) => n - 1)}
                  >
                    {t.storyWorkspace.previous}
                  </Button>
                  <span className="text-xs">
                    {filtered.length ? page * 48 + 1 : 0}–
                    {Math.min((page + 1) * 48, filtered.length)} /{" "}
                    {filtered.length}
                  </span>
                  <Button
                    size="sm"
                    disabled={(page + 1) * 48 >= filtered.length}
                    onClick={() => setPage((n) => n + 1)}
                  >
                    {t.storyWorkspace.next}
                  </Button>
                </div>
              </div>
              {mode === "split" && selected?.chapterId && (
                <div className="min-h-0 min-w-0 overflow-auto border-l border-paper-300">
                  <StoryProse
                    key={`${selected.id}:${tick}`}
                    novelId={novel.id}
                    node={selected}
                    w={w}
                    act={act}
                    onEdit={() => setMode("text")}
                  />
                </div>
              )}
            </div>
          )}
          {mode === "timeline" && (
            <div
              className="grid gap-5 p-5"
              style={{
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
              }}
            >
              <section>
                <h3 className="font-semibold">{t.storyWorkspace.world}</h3>
                <p className="my-3 text-xs text-ink-500">
                  {t.storyWorkspace.timeHint}
                </p>
                {timeline.layers.map((layer, i) => (
                  <div
                    key={i}
                    className="my-3 border-l-2 border-paper-300 pl-3"
                  >
                    {layer.map((n) => (
                      <button
                        key={n.id}
                        className="my-1 block w-full rounded-lg border border-paper-300 p-3 text-left text-sm"
                        onClick={() => pick(n)}
                      >
                        {n.title || t.storyWorkspace[n.kind]}
                        <span className="block text-xs text-ink-500">
                          {w.graph.nodes.find((m) => m.id === n.id)?.time
                            .label || t.storyWorkspace.unknown}{" "}
                          ·{" "}
                          {w.graph.nodes.find((m) => m.id === n.id)?.time
                            .start ?? "—"}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
                {timeline.cycles.length > 0 && (
                  <p role="alert">{timeline.cycles.join(", ")}</p>
                )}
              </section>
              <section>
                <h3 className="font-semibold">{t.storyWorkspace.reading}</h3>
                <p className="my-3 text-xs text-ink-500">
                  {t.storyWorkspace.narrativeHint}
                </p>
                {filtered.map((n) => (
                  <button
                    className="my-2 block w-full rounded-lg border border-paper-300 p-3 text-left text-sm"
                    key={n.id}
                    onClick={() => pick(n)}
                  >
                    {n.chapterNo ?? "—"} · {n.title || t.storyWorkspace[n.kind]}
                  </button>
                ))}
              </section>
            </div>
          )}
          {mode === "text" && <ChaptersTab novel={novel} />}
          {mode === "candidates" && (
            <StoryCandidates
              key={`${tick}:${jobTick}`}
              novelId={novel.id}
              w={w}
              act={act}
              busy={busy}
              onResume={(id) =>
                act((signal) => runMandate(novel.id, id, signal, setStream))
              }
            />
          )}
          {mode === "branches" && (
            <StoryBranchPanel
              key={`${tick}:${jobTick}`}
              novelId={novel.id}
              w={w}
              selected={selected}
              act={act}
              busy={busy}
            />
          )}
          {(["controls", "inbox", "voice", "resume"] as string[]).includes(
            mode,
          ) && (
            <StoryControlPanels
              key={`${mode}:${w.revision}`}
              mode={mode}
              novelId={novel.id}
              w={w}
              selected={selected}
              act={act}
              busy={busy}
              save={saveGraph}
              onPick={pick}
            />
          )}
          {busy && stream && (
            <details className="m-4" open>
              <summary>{t.storyWorkspace.running}</summary>
              <p className="max-h-64 overflow-auto whitespace-pre-wrap text-sm">
                {stream}
              </p>
            </details>
          )}
        </main>
        {mode !== "text" && (
          <aside
            id="story-inspector"
            className={cn(
              "w-80 max-w-full shrink-0 overflow-y-auto border-l border-paper-300 bg-paper-50 p-4 dark:border-paper-800 dark:bg-paper-950",
              !panels.inspectorInline &&
                "absolute inset-y-0 right-0 z-20 shadow-xl",
              !panels.inspectorInline && !inspectorOpen && "hidden",
            )}
          >
            {selected ? (
              <NodeInspector
                key={`${selected.id}:${w.revision}:${w.cards.find((c) => c.id === selected.id)?.revision}`}
                novelId={novel.id}
                node={selected}
                w={w}
                busy={busy}
                act={act}
                save={saveGraph}
                onProse={() => setMode("split")}
                onGenerate={async (ids, rules) => {
                  setMode("candidates");
                  await act(async (signal) => {
                    const mandate = await createMandate(novel.id, ids, rules);
                    await runMandate(novel.id, mandate.id, signal, setStream);
                  });
                }}
              />
            ) : (
              <p className="text-sm text-ink-500">
                {t.storyWorkspace.selectNode}
              </p>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

/** Bounded, keyboard-operable map. Connections reference real shared IDs, never duplicated outlines. */
export function StoryMap({
  nodes,
  graph,
  selectedId,
  onPick,
}: {
  nodes: StoryNode[];
  graph: StoryGraph;
  selectedId: string;
  onPick: (n: StoryNode) => void;
}) {
  const [mapRef, paneWidth] = usePaneWidth();
  const layout = storyMapLayout(nodes.length, paneWidth);
  const { width, cardWidth, cardHeight } = layout;
  const points = new Map(nodes.map((n, i) => [n.id, layout.point(i)]));
  const visible = graph.relations.filter(
    (r) => points.has(r.from) && points.has(r.to),
  );
  return (
    <div ref={mapRef} className="w-full min-w-0">
      <div
        className="relative"
        style={{
          width,
          height: layout.height,
        }}
      >
        <svg
          className="pointer-events-none absolute inset-0 text-ink-400"
          width={width}
          height="100%"
          aria-hidden="true"
        >
          <defs>
            <marker
              id="story-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="3"
              orient="auto"
            >
              <path d="M0,0 L0,6 L7,3 z" fill="currentColor" />
            </marker>
          </defs>
          {visible.map((r) => {
            const a = points.get(r.from)!,
              b = points.get(r.to)!;
            return (
              <path
                key={r.id}
                d={`M${a.x + cardWidth / 2},${a.y + cardHeight} C${a.x + cardWidth / 2},${a.y + cardHeight + 28} ${b.x + cardWidth / 2},${b.y - 18} ${b.x + cardWidth / 2},${b.y}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={
                  r.from === selectedId || r.to === selectedId ? 2.5 : 1
                }
                strokeDasharray={r.status === "proposed" ? "5 4" : undefined}
                markerEnd="url(#story-arrow)"
              />
            );
          })}
        </svg>
        {nodes.map((n) => {
          const p = points.get(n.id)!,
            meta = graph.nodes.find((m) => m.id === n.id);
          return (
            <button
              key={n.id}
              onClick={() => onPick(n)}
              aria-pressed={selectedId === n.id}
              className={cn(
                "absolute flex min-w-0 flex-col rounded-xl border bg-paper-0 p-3 text-left shadow-sm dark:bg-paper-900",
                selectedId === n.id
                  ? "border-cinnabar-500 ring-1 ring-cinnabar-500"
                  : "border-paper-300 dark:border-paper-700",
              )}
              style={{
                left: p.x,
                top: p.y,
                width: cardWidth,
                height: cardHeight,
              }}
            >
              <span className="text-[10px] text-ink-500">
                {t.storyWorkspace[n.kind]} · {n.chapterNo ?? "—"}{" "}
                {graph.lockedNodeIds.includes(n.id) &&
                  `· ${t.storyWorkspace.lock}`}
              </span>
              <span className="my-1 line-clamp-3 break-words text-sm font-semibold">
                {n.title || t.storyWorkspace.unknown}
              </span>
              <span className="mt-auto truncate text-xs text-ink-500">
                {meta?.time.label || t.storyWorkspace.unknown}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NodeInspector({
  novelId,
  node,
  w,
  busy,
  act,
  save,
  onProse,
  onGenerate,
}: {
  novelId: string;
  node: StoryNode;
  w: Workspace;
  busy: boolean;
  act: StoryAction;
  save: (g: StoryGraph, label: string) => Promise<void>;
  onProse: () => void;
  onGenerate: (
    ids: string[],
    rules: { must: string; may: string; mustNot: string },
  ) => Promise<void>;
}) {
  const card = w.cards.find((c) => c.id === node.id);
  const beat = w.beats.find((b) => b.id === node.id);
  const [beatDraft, setBeatDraft] = useState(beat);
  const [plan, setPlan] = useState(card?.kind === "scene" ? card.data : null),
    [chapterId, setChapterId] = useState(node.chapterId ?? ""),
    [order, setOrder] = useState(node.order);
  const [metadata, setMetadata] = useState(
    w.graph.nodes.find((n) => n.id === node.id) ?? {
      id: node.id,
      arcId: node.arcId,
      time: { label: "", start: null, end: null },
    },
  );
  const [target, setTarget] = useState(""),
    [relation, setRelation] =
      useState<StoryGraph["relations"][number]["kind"]>("causes"),
    [reason, setReason] = useState("");
  const [preview, setPreview] = useState<"plan" | StoryGraph | null>(null),
    [scope, setScope] = useState<string[]>(
      node.kind === "scene" ? [node.id] : [],
    );
  const [must, setMust] = useState(""),
    [may, setMay] = useState(""),
    [mustNot, setMustNot] = useState("");
  const impactGraph =
    typeof preview === "object" && preview
      ? {
          ...preview,
          relations: [
            ...new Map(
              [...w.graph.relations, ...preview.relations].map((r) => [
                r.id,
                r,
              ]),
            ).values(),
          ],
        }
      : w.graph;
  const impact = storyImpact(impactGraph, [node.id]);
  const affectedNodes = w.nodes.filter((n) =>
    impact.some((i) => i.nodeId === n.id),
  );
  const affectedCharacters = w.characters.filter((c) =>
    affectedNodes.some((n) => n.characterIds.includes(c.id)),
  );
  const affectedThreads = w.cards.filter(
    (c) =>
      c.kind === "thread" &&
      w.cards.some(
        (s) =>
          s.kind === "scene" &&
          affectedNodes.some((n) => n.id === s.id) &&
          s.data.threadIds.includes(c.id),
      ),
  );
  const links = w.graph.relations.filter(
    (r) => r.from === node.id || r.to === node.id,
  );
  const update = () => {
    const graph = structuredClone(w.graph);
    graph.nodes = [...graph.nodes.filter((n) => n.id !== node.id), metadata];
    setPreview(graph);
  };
  return (
    <fieldset disabled={busy} className="min-w-0">
      <h3 className="font-semibold">
        {node.title || t.storyWorkspace[node.kind]}
      </h3>
      <p className="my-2 text-xs text-ink-500">
        {card
          ? card.confirmed
            ? t.storyWorkspace.confirmed
            : t.storyWorkspace.proposed
          : t.storyWorkspace.plan}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onProse}>
          {t.storyWorkspace.original}
        </Button>
        <Button
          size="sm"
          onClick={() =>
            save(
              {
                ...w.graph,
                lockedNodeIds: w.graph.lockedNodeIds.includes(node.id)
                  ? w.graph.lockedNodeIds.filter((id) => id !== node.id)
                  : [...w.graph.lockedNodeIds, node.id],
              },
              "lock",
            )
          }
        >
          {w.graph.lockedNodeIds.includes(node.id)
            ? t.storyWorkspace.unlock
            : t.storyWorkspace.lock}
        </Button>
      </div>
      {beatDraft && (
        <details open>
          <summary className="mt-4 cursor-pointer font-medium">
            {t.storyWorkspace.beat}
          </summary>
          <StoryArea
            label={t.storyWorkspace.titleField}
            value={beatDraft.title}
            onChange={(title) => setBeatDraft({ ...beatDraft, title })}
          />
          <StoryArea
            label={t.storyWorkspace.note}
            value={beatDraft.summary}
            onChange={(summary) => setBeatDraft({ ...beatDraft, summary })}
          />
          <Button size="sm" onClick={() => setPreview("plan")}>
            {t.storyWorkspace.preview}
          </Button>
        </details>
      )}
      {plan && card?.kind === "scene" && (
        <details open>
          <summary className="mt-4 cursor-pointer font-medium">
            {t.storyWorkspace.plan}
          </summary>
          {(["title", "goal", "obstacle", "turn", "outcome"] as const).map(
            (key) => (
              <StoryArea
                key={key}
                label={
                  key === "title"
                    ? t.storyWorkspace.titleField
                    : t.storyWorkspace[key]
                }
                value={plan[key]}
                onChange={(value) => setPlan({ ...plan, [key]: value })}
              />
            ),
          )}
          <StoryField label={t.storyWorkspace.chapter}>
            <Select
              value={chapterId}
              onChange={(e) => setChapterId(e.target.value)}
            >
              {w.chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.chapterNo} · {c.title}
                </option>
              ))}
            </Select>
          </StoryField>
          <StoryField label={t.storyWorkspace.order}>
            <Input
              type="number"
              min={0}
              value={order}
              onChange={(e) => setOrder(Number(e.target.value))}
            />
          </StoryField>
          <p className="text-xs text-ink-500">
            {t.storyWorkspace.narrativeHint}
          </p>
          <Button size="sm" onClick={() => setPreview("plan")}>
            {t.storyWorkspace.preview}
          </Button>
          {!card.confirmed && (
            <Button
              size="sm"
              onClick={() =>
                act(() =>
                  saveWritingCard(
                    novelId,
                    { kind: "scene", data: plan },
                    {
                      id: card.id,
                      expectedRevision: card.revision,
                      chapterId: card.chapterId,
                      confirmed: true,
                    },
                  ),
                )
              }
            >
              {t.storyWorkspace.confirmed}
            </Button>
          )}
        </details>
      )}
      <details>
        <summary className="mt-4 cursor-pointer font-medium">
          {t.storyWorkspace.world}
        </summary>
        <StoryField label={t.storyWorkspace.arc}>
          <Select
            value={metadata.arcId ?? ""}
            onChange={(e) =>
              setMetadata({ ...metadata, arcId: e.target.value || null })
            }
          >
            <option value="">{t.storyWorkspace.unknown}</option>
            {w.arcs.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </Select>
        </StoryField>
        <StoryField label={t.storyWorkspace.timeLabel}>
          <Input
            value={metadata.time.label}
            onChange={(e) =>
              setMetadata({
                ...metadata,
                time: { ...metadata.time, label: e.target.value },
              })
            }
          />
        </StoryField>
        {(["start", "end"] as const).map((key) => (
          <StoryField key={key} label={t.storyWorkspace[key]}>
            <Input
              type="number"
              value={metadata.time[key] ?? ""}
              onChange={(e) =>
                setMetadata({
                  ...metadata,
                  time: {
                    ...metadata.time,
                    [key]:
                      e.target.value === "" ? null : Number(e.target.value),
                  },
                })
              }
            />
          </StoryField>
        ))}
        <Button size="sm" onClick={update}>
          {t.storyWorkspace.preview}
        </Button>
      </details>
      <details open>
        <summary className="mt-4 cursor-pointer font-medium">
          {t.storyWorkspace.relation}
        </summary>
        {links.map((r) => (
          <div
            className="my-2 rounded border border-paper-300 p-2 text-xs"
            key={r.id}
          >
            <p>
              {w.nodes.find((n) => n.id === r.from)?.title || r.from} →{" "}
              {t.storyWorkspace[r.kind]} →{" "}
              {w.nodes.find((n) => n.id === r.to)?.title || r.to}
            </p>
            <p>{r.reason}</p>
            <p className="text-ink-500">{t.storyWorkspace[r.status]}</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setPreview({
                  ...w.graph,
                  relations: w.graph.relations.filter(
                    (link) => link.id !== r.id,
                  ),
                })
              }
            >
              {t.storyWorkspace.remove}
            </Button>
            {r.status === "proposed" && (
              <Button
                size="sm"
                onClick={() =>
                  setPreview({
                    ...w.graph,
                    relations: w.graph.relations.map((link) =>
                      link.id === r.id
                        ? { ...link, status: "confirmed" }
                        : link,
                    ),
                  })
                }
              >
                {t.storyWorkspace.confirmed}
              </Button>
            )}
          </div>
        ))}
        <NodeSelect
          w={w}
          value={target}
          onChange={setTarget}
          label={t.storyWorkspace.target}
        />
        <Select
          aria-label={t.storyWorkspace.relation}
          value={relation}
          onChange={(e) => setRelation(e.target.value as typeof relation)}
        >
          {(
            [
              "causes",
              "requires",
              "before",
              "parallel",
              "setup",
              "payoff",
            ] as const
          ).map((k) => (
            <option key={k} value={k}>
              {t.storyWorkspace[k]}
            </option>
          ))}
        </Select>
        <StoryArea
          label={t.storyWorkspace.reason}
          value={reason}
          onChange={setReason}
        />
        <Button
          size="sm"
          disabled={!target || target === node.id || !reason.trim()}
          onClick={() =>
            setPreview({
              ...w.graph,
              relations: [
                ...w.graph.relations,
                {
                  id: nanoid(),
                  from: node.id,
                  to: target,
                  kind: relation,
                  status: "confirmed",
                  reason,
                },
              ],
            })
          }
        >
          {t.storyWorkspace.preview}
        </Button>
      </details>
      {preview && (
        <section
          className="my-4 rounded-xl border border-amber-500 p-3"
          aria-label={t.storyWorkspace.impact}
        >
          <h4 className="font-medium">{t.storyWorkspace.impact}</h4>
          <p className="my-2 text-xs">{t.storyWorkspace.impactHint}</p>
          <p className="my-2 text-xs">
            {t.storyWorkspace.character}:{" "}
            {affectedCharacters.map((c) => c.name).join(" · ") || "—"}
          </p>
          <p className="my-2 text-xs">
            {t.storyWorkspace.thread}:{" "}
            {affectedThreads
              .map((c) => (c.kind === "thread" ? c.data.title : ""))
              .join(" · ") || "—"}
          </p>
          {impact.map((i) => (
            <p className="my-2 text-xs" key={i.nodeId}>
              {w.nodes.find((n) => n.id === i.nodeId)?.title || i.nodeId} ·{" "}
              {t.storyWorkspace[i.certainty]}
              <span className="block">
                {i.path.map((r) => r.reason).join(" → ")}
              </span>
            </p>
          ))}
          <Button
            size="sm"
            onClick={async () => {
              if (preview === "plan" && card && plan)
                await act(() =>
                  editStoryScene(
                    novelId,
                    w.revision,
                    card,
                    plan,
                    chapterId,
                    order,
                  ),
                );
              else if (preview === "plan" && beat && beatDraft)
                await act(() =>
                  editStoryBeat(novelId, w.revision, beat, beatDraft),
                );
              else if (preview !== "plan") await save(preview, "structure");
            }}
          >
            {t.storyWorkspace.apply}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
            {t.common.cancel}
          </Button>
        </section>
      )}
      <details>
        <summary className="mt-4 cursor-pointer font-medium">
          {t.storyWorkspace.choose}
        </summary>
        <p className="my-2 text-xs text-ink-500">
          {t.storyWorkspace.mandateHint}
        </p>
        <Button
          size="sm"
          onClick={() =>
            setScope(
              w.nodes
                .filter(
                  (n) => n.kind === "scene" && n.chapterId === node.chapterId,
                )
                .map((n) => n.id),
            )
          }
        >
          {t.storyWorkspace.chooseChapter}
        </Button>
        <Button
          size="sm"
          disabled={!node.arcId}
          onClick={() =>
            setScope(
              w.nodes
                .filter((n) => n.kind === "scene" && n.arcId === node.arcId)
                .map((n) => n.id),
            )
          }
        >
          {t.storyWorkspace.chooseArc}
        </Button>
        {w.nodes
          .filter(
            (n) =>
              n.kind === "scene" &&
              (scope.includes(n.id) || impact.some((i) => i.nodeId === n.id)),
          )
          .map((n) => (
            <label className="my-2 block text-xs" key={n.id}>
              <input
                type="checkbox"
                checked={scope.includes(n.id)}
                onChange={(e) =>
                  setScope((s) =>
                    e.target.checked
                      ? [...new Set([...s, n.id])]
                      : s.filter((id) => id !== n.id),
                  )
                }
              />{" "}
              {n.title || t.storyWorkspace.scene}
            </label>
          ))}
        <StoryArea
          label={t.storyWorkspace.must}
          value={must}
          onChange={setMust}
        />
        <StoryArea label={t.storyWorkspace.may} value={may} onChange={setMay} />
        <StoryArea
          label={t.storyWorkspace.mustNot}
          value={mustNot}
          onChange={setMustNot}
        />
        <Button
          disabled={!scope.length}
          onClick={() => onGenerate(scope, { must, may, mustNot })}
        >
          {t.storyWorkspace.authorize}
        </Button>
      </details>
    </fieldset>
  );
}

function StoryProse({
  novelId,
  node,
  w,
  act,
  onEdit,
}: {
  novelId: string;
  node: StoryNode;
  w: Workspace;
  act: StoryAction;
  onEdit: () => void;
}) {
  const chapter = w.chapters.find((c) => c.id === node.chapterId);
  const {
    data: version,
    error,
    reload,
  } = useAsyncData(
    () =>
      chapter?.currentVersionId
        ? getVersion(chapter.currentVersionId)
        : Promise.resolve(null),
    { key: `graph-prose:${chapter?.currentVersionId}:${chapter?.updatedAt}` },
  );
  const [selection, setSelection] = useState({ from: 0, to: 0 });
  if (error || version === undefined)
    return <AsyncNotice error={error} retry={reload} />;
  const anchors = w.graph.anchors.filter((a) => a.nodeId === node.id);
  return (
    <div className="flex h-full min-h-80 min-w-0 flex-col p-4">
      <h3 className="font-semibold">
        {chapter?.title || t.storyWorkspace.original}
      </h3>
      <p className="my-2 text-xs text-ink-500">{t.storyWorkspace.readOnly}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onEdit}>
          {t.storyWorkspace.edit}
        </Button>
        <Button
          size="sm"
          disabled={!version?.content}
          onClick={() =>
            act((signal) => readStoryProse(novelId, chapter!.id, signal))
          }
        >
          {t.storyWorkspace.extract}
        </Button>
      </div>
      <div className="max-h-28 shrink-0 overflow-auto">
        {anchors.map((a) => (
          <div key={a.id} className="my-2 text-xs">
            {anchorState(a, version) === "current"
              ? t.storyWorkspace.current
              : t.storyWorkspace.stale}{" "}
            · {a.interpretation}
            <q className="mx-2">{a.evidence.quote}</q>
            <Button
              size="sm"
              disabled={
                w.graph.preferences.sampleAnchorIds.includes(a.id) ||
                w.graph.growth.some((g) => g.anchorId === a.id)
              }
              onClick={() =>
                act(() =>
                  saveStoryGraph(
                    novelId,
                    w.revision,
                    {
                      ...w.graph,
                      anchors: w.graph.anchors.filter((x) => x.id !== a.id),
                    },
                    "unlink",
                  ),
                )
              }
            >
              {t.storyWorkspace.remove}
            </Button>
          </div>
        ))}
      </div>
      <textarea
        readOnly
        aria-label={t.storyWorkspace.original}
        value={version?.content ?? ""}
        onSelect={(e) =>
          setSelection({
            from: e.currentTarget.selectionStart,
            to: e.currentTarget.selectionEnd,
          })
        }
        className="my-3 min-h-0 w-full flex-1 resize-none border-0 bg-transparent font-serif text-base leading-loose outline-none"
      />
      <p className="text-xs text-ink-500">
        {t.storyWorkspace.selection}: {selection.from}–{selection.to}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {(["link", "lockedText"] as const).map((action) => (
          <Button
            key={action}
            size="sm"
            disabled={selection.from === selection.to || !chapter}
            onClick={() =>
              act(async () => {
                const anchor = await makeStoryAnchor(
                  node.id,
                  chapter!.id,
                  selection.from,
                  selection.to,
                );
                const existing = w.graph.anchors.find(
                  (a) =>
                    a.nodeId === node.id &&
                    a.versionId === anchor.versionId &&
                    a.evidence.from === anchor.evidence.from &&
                    a.evidence.to === anchor.evidence.to,
                );
                if (existing && action === "link")
                  Object.assign(anchor, {
                    id: existing.id,
                    interpretation: existing.interpretation,
                  });
                await saveStoryGraph(
                  novelId,
                  w.revision,
                  action === "link"
                    ? {
                        ...w.graph,
                        anchors: [
                          ...w.graph.anchors.filter((a) => a.id !== anchor.id),
                          anchor,
                        ],
                      }
                    : {
                        ...w.graph,
                        lockedAnchors: [...w.graph.lockedAnchors, anchor],
                      },
                  action,
                );
              })
            }
          >
            {t.storyWorkspace[action]}
          </Button>
        ))}
      </div>
      <div className="max-h-24 shrink-0 overflow-auto">
        {w.graph.lockedAnchors
          .filter((a) => a.chapterId === chapter?.id)
          .map((a) => (
            <div key={a.id} className="mt-3 text-xs">
              <q>{a.evidence.quote}</q>
              <Button
                size="sm"
                onClick={() =>
                  act(() =>
                    saveStoryGraph(
                      novelId,
                      w.revision,
                      {
                        ...w.graph,
                        lockedAnchors: w.graph.lockedAnchors.filter(
                          (x) => x.id !== a.id,
                        ),
                      },
                      "unlock",
                    ),
                  )
                }
              >
                {t.storyWorkspace.unlock}
              </Button>
            </div>
          ))}
      </div>
    </div>
  );
}
