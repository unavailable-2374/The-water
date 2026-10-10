import { useState } from "react";
import { Link } from "react-router";
import { nanoid } from "nanoid";
import {
  narrativeOrder,
  type StoryGraph,
  type StoryNode,
  type WritingMandate,
} from "@the-water/shared";
import { Button, Input, Select } from "@/components/ui";
import { useAsyncData } from "@/components/data/useAsyncData";
import { AsyncNotice } from "@/components/data/AsyncNotice";
import { t } from "@/i18n";
import type { StoryWorkspace as Workspace } from "@/db/repos/storyGraphRepo";
import {
  discardProposal,
  listCanonEvents,
  listThreadStates,
} from "@/db/repos/writingRepo";
import { listTextProposals } from "@/novel/assistant";
import {
  applyStoryProposal,
  cancelMandate,
  listMandates,
} from "@/novel/storyMandates";
import {
  acceptStoryReading,
  dismissStoryReading,
  discussStory,
  listStoryDiscussions,
  listStoryReadings,
  suggestStoryVoice,
} from "@/novel/storyIntelligence";
import {
  branchConflicts,
  createStoryBranch,
  generateBranchSample,
  listStoryBranches,
  mergeStoryBranch,
  saveStoryBranch,
  type StoryBranch,
} from "@/novel/storyBranches";
import {
  NodeSelect,
  StoryArea,
  StoryField,
  type StoryAction,
} from "./StoryWorkspace";

interface Props {
  novelId: string;
  w: Workspace;
  act: StoryAction;
  busy: boolean;
}
export function StoryCandidates({
  novelId,
  w,
  act,
  busy,
  onResume,
}: Props & { onResume: (id: string) => void }) {
  const { data, error, reload } = useAsyncData(
    async () => ({
      mandates: await listMandates(novelId),
      readings: await listStoryReadings(novelId),
      proposals: (
        await Promise.all(w.chapters.map((c) => listTextProposals(c.id)))
      ).flat(),
    }),
    { key: `story-candidates:${novelId}` },
  );
  if (!data || error) return <AsyncNotice error={error} retry={reload} />;
  return (
    <div className="space-y-6 p-6">
      <h3 className="text-lg font-semibold">{t.storyWorkspace.candidates}</h3>
      {data.mandates.map((m) => (
        <article key={m.id} className="rounded-xl border border-paper-300 p-4">
          <h4>
            {t.storyWorkspace[m.state]} ·{" "}
            {m.targets.filter((t) => t.state === "done").length}/
            {m.targets.length}
          </h4>
          <p className="my-2 text-sm">
            {m.nodeIds
              .map((id) => w.nodes.find((n) => n.id === id)?.title || id)
              .join(" · ")}
          </p>
          <p className="text-xs text-ink-500">
            {t.storyWorkspace.must}: {m.must}
            <br />
            {t.storyWorkspace.may}: {m.may}
            <br />
            {t.storyWorkspace.mustNot}: {m.mustNot}
          </p>
          {m.error && (
            <p role="alert" className="my-2 text-sm text-cinnabar-600">
              {m.error}
            </p>
          )}
          {(
            ["ready", "running", "paused"] as WritingMandate["state"][]
          ).includes(m.state) && (
            <>
              <p className="my-2 text-xs">{t.storyWorkspace.interrupted}</p>
              <Button size="sm" disabled={busy} onClick={() => onResume(m.id)}>
                {t.storyWorkspace.continueTask}
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => act(() => cancelMandate(novelId, m.id))}
              >
                {t.storyWorkspace.cancelTask}
              </Button>
            </>
          )}
        </article>
      ))}
      {data.proposals.map((p) => (
        <article key={p.id} className="rounded-xl border border-paper-300 p-4">
          <h4 className="mb-3 font-semibold">
            {w.chapters.find((c) => c.id === p.chapterId)?.title ||
              t.storyWorkspace.chapter}
          </h4>
          <div className="grid grid-cols-2 gap-4">
            <section>
              <h5 className="mb-2 text-xs text-ink-500">
                {t.storyWorkspace.beforeText}
              </h5>
              <p className="whitespace-pre-wrap text-sm">{p.original}</p>
            </section>
            <section>
              <h5 className="mb-2 text-xs text-ink-500">
                {t.storyWorkspace.afterText}
              </h5>
              <p className="whitespace-pre-wrap text-sm">{p.replacement}</p>
            </section>
          </div>
          <div className="mt-4 flex gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                act(() => applyStoryProposal(novelId, p.chapterId, p.id))
              }
            >
              {t.storyWorkspace.accept}
            </Button>
            <Button
              disabled={busy}
              onClick={() => act(() => discardProposal(p.id))}
            >
              {t.storyWorkspace.discard}
            </Button>
          </div>
        </article>
      ))}
      {data.readings.map((s) => (
        <article key={s.id} className="rounded-xl border border-paper-300 p-4">
          <h4 className="font-semibold">{t.storyWorkspace.editorial}</h4>
          <p className="my-2 text-xs text-ink-500">
            {w.chapters.find((c) => c.id === s.chapterId)?.title} ·{" "}
            {s.versionId}
          </p>
          {s.reading.scenes.map((scene, i) => (
            <details key={i} className="my-3">
              <summary>{scene.plan.title}</summary>
              <p className="my-2 text-sm">{scene.interpretation}</p>
              <blockquote className="border-l-2 border-paper-300 pl-3 text-sm">
                {scene.evidence.quote}
              </blockquote>
              <div className="my-3 grid grid-cols-2 gap-3">
                <p className="text-sm">
                  {t.storyWorkspace.plan}:{" "}
                  {w.cards.find((c) => c.id === scene.existingSceneId)?.kind ===
                  "scene"
                    ? JSON.stringify(
                        w.cards.find((c) => c.id === scene.existingSceneId)
                          ?.data,
                      )
                    : t.storyWorkspace.unknown}
                </p>
                <p className="text-sm">
                  {t.storyWorkspace.outcome}: {scene.plan.outcome}
                </p>
              </div>
            </details>
          ))}
          {!s.reading.issues.length && (
            <p className="text-sm">{t.storyWorkspace.noIssues}</p>
          )}
          {s.reading.issues.map((issue, i) => (
            <div className="my-3 border-t border-paper-300 pt-3" key={i}>
              <p className="font-medium">{t.storyWorkspace[issue.kind]}</p>
              <p className="my-1 text-sm">
                {t.storyWorkspace.purpose}: {issue.purpose}
              </p>
              <p className="text-sm">{issue.suggestion}</p>
              <blockquote className="my-2 border-l-2 border-amber-500 pl-3 text-sm">
                {issue.evidence.quote}
              </blockquote>
              <Link
                className="text-xs underline"
                to={`/studio/${novelId}/chapters?chapter=${encodeURIComponent(s.chapterId)}&from=${issue.evidence.from}&to=${issue.evidence.to}&version=${encodeURIComponent(s.versionId)}`}
              >
                {t.storyWorkspace.evidence}
              </Link>
            </div>
          ))}
          <Button
            disabled={busy || !s.reading.scenes.length}
            onClick={() => act(() => acceptStoryReading(novelId, s.id))}
          >
            {t.storyWorkspace.updatePlan}
          </Button>
          <Button
            disabled={busy}
            onClick={() => act(() => dismissStoryReading(novelId, s.id))}
          >
            {t.storyWorkspace.discard}
          </Button>
          <p className="mt-2 text-xs text-ink-500">
            {t.storyWorkspace.keepPlan}
          </p>
        </article>
      ))}
    </div>
  );
}

export function StoryControlPanels({
  mode,
  novelId,
  w,
  selected,
  act,
  busy,
  save,
  onPick,
}: Props & {
  mode: string;
  selected?: StoryNode;
  save: (g: StoryGraph, label: string) => Promise<void>;
  onPick: (n: StoryNode) => void;
}) {
  const [characterId, setCharacterId] = useState(w.characters[0]?.id ?? ""),
    [at, setAt] = useState(selected?.id ?? ""),
    [related, setRelated] = useState("");
  const [kind, setKind] =
      useState<StoryGraph["growth"][number]["kind"]>("goal"),
    [before, setBefore] = useState(""),
    [after, setAfter] = useState("");
  const [secret, setSecret] = useState(""),
    [readerAt, setReaderAt] = useState(""),
    [knows, setKnows] = useState<"knows" | "believes">("knows"),
    [belief, setBelief] = useState("");
  const [note, setNote] = useState(""),
    [source, setSource] = useState(""),
    [noteKind, setNoteKind] =
      useState<StoryGraph["inbox"][number]["kind"]>("idea");
  const [voice, setVoice] = useState(w.graph.preferences),
    [question, setQuestion] = useState("");
  const { data: established } = useAsyncData(
    async () => ({
      facts: await listCanonEvents(novelId, 501),
      threads: await listThreadStates(novelId),
    }),
    {
      key: `story-established:${novelId}:${w.revision}`,
      enabled: mode === "controls" || mode === "resume",
    },
  );
  const {
    data: discussions,
    error,
    reload,
  } = useAsyncData(() => listStoryDiscussions(novelId), {
    key: `story-discussions:${novelId}`,
    enabled: mode === "resume",
  });
  const characterSelect = (
    label: string,
    value: string,
    change: (v: string) => void,
    empty = false,
  ) => (
    <StoryField label={label}>
      <Select
        aria-label={label}
        value={value}
        onChange={(e) => change(e.target.value)}
      >
        {empty && <option value="">{t.storyWorkspace.unknown}</option>}
        {w.characters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
    </StoryField>
  );
  const title = (id: string | null) =>
    w.nodes.find((n) => n.id === id)?.title || t.storyWorkspace.unknown;
  const nodeLink = (id: string) => (
    <button
      className="text-sm underline"
      onClick={() => {
        const n = w.nodes.find((n) => n.id === id);
        if (n) onPick(n);
      }}
    >
      {title(id)}
    </button>
  );
  return (
    <fieldset disabled={busy} className="max-w-4xl p-6">
      {mode === "controls" && (
        <>
          <h3 className="text-lg font-semibold">{t.storyWorkspace.growth}</h3>
          {characterSelect(
            t.storyWorkspace.character,
            characterId,
            setCharacterId,
          )}
          <Button
            size="sm"
            disabled={!characterId}
            onClick={() =>
              save(
                {
                  ...w.graph,
                  lockedNodeIds: w.graph.lockedNodeIds.includes(characterId)
                    ? w.graph.lockedNodeIds.filter((id) => id !== characterId)
                    : [...w.graph.lockedNodeIds, characterId],
                },
                "lock",
              )
            }
          >
            {w.graph.lockedNodeIds.includes(characterId)
              ? t.storyWorkspace.unlock
              : t.storyWorkspace.lock}{" "}
            · {t.storyWorkspace.character}
          </Button>
          <details className="my-4">
            <summary>
              {t.storyWorkspace.lock} · {t.storyWorkspace.plan}
            </summary>
            {w.cards
              .filter((c) => c.kind === "brief" || c.kind === "character")
              .map((c) => (
                <label key={c.id} className="my-2 block text-sm">
                  <input
                    type="checkbox"
                    checked={w.graph.lockedNodeIds.includes(c.id)}
                    onChange={(e) =>
                      save(
                        {
                          ...w.graph,
                          lockedNodeIds: e.target.checked
                            ? [...w.graph.lockedNodeIds, c.id]
                            : w.graph.lockedNodeIds.filter((id) => id !== c.id),
                        },
                        "lock",
                      )
                    }
                  />{" "}
                  {c.kind === "brief" ? c.data.ending : c.data.goal}
                </label>
              ))}
          </details>
          <details className="my-4">
            <summary>
              {t.storyWorkspace.facts} · {t.storyWorkspace.evidence}
            </summary>
            {established?.facts
              .filter(
                (f) =>
                  f.entityId === characterId || f.knownBy.includes(characterId),
              )
              .map((f) => (
                <article
                  key={f.id}
                  className="my-3 border-l-2 border-paper-300 pl-3"
                >
                  <p className="text-sm">
                    {f.chapterNo} · {f.text}
                  </p>
                  <q className="block text-xs">{f.evidence.quote}</q>
                  <Link
                    className="text-xs underline"
                    to={`/studio/${novelId}/chapters?chapterNo=${f.chapterNo}&version=${encodeURIComponent(f.versionId)}&from=${f.evidence.from}&to=${f.evidence.to}`}
                  >
                    {t.storyWorkspace.evidence}
                  </Link>
                </article>
              ))}
          </details>
          <details className="my-4">
            <summary>{t.storyWorkspace.thread}</summary>
            {w.cards.flatMap((c) =>
              c.kind === "thread"
                ? [
                    <article
                      className="my-3 rounded border border-paper-300 p-3 text-sm"
                      key={c.id}
                    >
                      <h4>{c.data.title}</h4>
                      <p>
                        {t.storyWorkspace.setup}: {c.data.setup}
                      </p>
                      <p>{c.data.progression}</p>
                      {c.data.milestones?.map((m,i)=><p key={i} className="mt-1 text-xs">{m.chapterNo} · {m.kind==='setup' ? t.storyWorkspace.setup : m.kind==='payoff' ? t.storyWorkspace.payoff : t.studio.workbench.fields.progression} · {m.detail}</p>)}
                      <p>
                        {t.storyWorkspace.payoff}: {c.data.payoff}
                      </p>
                      <p className="mt-2 text-xs">
                        {established?.threads.find((f) => f.threadId === c.id)
                          ?.quote || t.storyWorkspace.missing}
                      </p>
                    </article>,
                  ]
                : [],
            )}
          </details>
          <div className="my-4 flex flex-wrap gap-2">
            {narrativeOrder(
              w.nodes.filter((n) => n.characterIds.includes(characterId)),
            ).map((n) => (
              <Button size="sm" key={n.id} onClick={() => onPick(n)}>
                {n.chapterNo ?? "—"} · {n.title}
              </Button>
            ))}
          </div>
          {w.graph.growth
            .filter((g) => g.characterId === characterId)
            .map((g) => (
              <article
                key={g.id}
                className="my-3 rounded-xl border border-paper-300 p-3"
              >
                {nodeLink(g.at)} · {t.storyWorkspace[g.kind]}
                {g.relatedCharacterId &&
                  ` · ${w.characters.find((c) => c.id === g.relatedCharacterId)?.name}`}
                <p className="my-2 text-sm">
                  {g.before} → {g.after}
                </p>
                <Button
                  size="sm"
                  onClick={() =>
                    save(
                      {
                        ...w.graph,
                        growth: w.graph.growth.filter((x) => x.id !== g.id),
                      },
                      "growth",
                    )
                  }
                >
                  {t.storyWorkspace.remove}
                </Button>
              </article>
            ))}
          {!w.graph.growth.some((g) => g.characterId === characterId) && (
            <p className="text-sm text-ink-500">{t.storyWorkspace.noGrowth}</p>
          )}
          <NodeSelect
            w={w}
            label={t.storyWorkspace.at}
            value={at}
            onChange={setAt}
          />
          <Select
            aria-label={t.storyWorkspace.growth}
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            {(
              ["goal", "belief", "relationship", "situation", "choice"] as const
            ).map((k) => (
              <option key={k} value={k}>
                {t.storyWorkspace[k]}
              </option>
            ))}
          </Select>
          {characterSelect(t.storyWorkspace.related, related, setRelated, true)}
          <StoryArea
            label={t.storyWorkspace.beforeState}
            value={before}
            onChange={setBefore}
          />
          <StoryArea
            label={t.storyWorkspace.afterState}
            value={after}
            onChange={setAfter}
          />
          <Button
            disabled={!characterId || !at || !after.trim()}
            onClick={() =>
              save(
                {
                  ...w.graph,
                  growth: [
                    ...w.graph.growth,
                    {
                      id: nanoid(),
                      characterId,
                      at,
                      relatedCharacterId: related || null,
                      kind,
                      before,
                      after,
                      anchorId: null,
                    },
                  ],
                },
                "growth",
              )
            }
          >
            {t.storyWorkspace.addGrowth}
          </Button>
          <h3 className="mt-8 text-lg font-semibold">
            {t.storyWorkspace.secret}
          </h3>
          <p className="my-2 text-xs text-ink-500">
            {t.storyWorkspace.plan} · {t.storyWorkspace.confirmed}
          </p>
          {w.graph.secrets.map((s) => (
            <article
              key={s.id}
              className="my-4 rounded-xl border border-paper-300 p-4"
            >
              <h4 className="font-medium">{s.fact}</h4>
              <p className="my-2 text-sm">
                {t.storyWorkspace.readerAt}:{" "}
                {s.readerAt ? nodeLink(s.readerAt) : t.storyWorkspace.unknown}
              </p>
              {s.knowledge.map((k, i) => (
                <p key={i} className="my-2 text-sm">
                  {w.characters.find((c) => c.id === k.characterId)?.name} ·{" "}
                  {t.storyWorkspace[k.state]} · {nodeLink(k.at)} · {k.belief}
                </p>
              ))}
              <Button
                size="sm"
                disabled={!characterId || !at}
                onClick={() =>
                  save(
                    {
                      ...w.graph,
                      secrets: w.graph.secrets.map((x) =>
                        x.id === s.id
                          ? {
                              ...x,
                              knowledge: [
                                ...x.knowledge,
                                { characterId, at, state: knows, belief },
                              ],
                            }
                          : x,
                      ),
                    },
                    "knowledge",
                  )
                }
              >
                {t.storyWorkspace.addKnowledge}
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  save(
                    {
                      ...w.graph,
                      secrets: w.graph.secrets.filter((x) => x.id !== s.id),
                    },
                    "secret",
                  )
                }
              >
                {t.storyWorkspace.remove}
              </Button>
            </article>
          ))}
          <Select
            aria-label={t.storyWorkspace.knowledge}
            value={knows}
            onChange={(e) => setKnows(e.target.value as typeof knows)}
          >
            <option value="knows">{t.storyWorkspace.knows}</option>
            <option value="believes">{t.storyWorkspace.believes}</option>
          </Select>
          <StoryArea
            label={t.storyWorkspace.beliefText}
            value={belief}
            onChange={setBelief}
          />
          <StoryArea
            label={t.storyWorkspace.fact}
            value={secret}
            onChange={setSecret}
          />
          <NodeSelect
            w={w}
            value={readerAt}
            onChange={setReaderAt}
            label={t.storyWorkspace.readerAt}
          />
          <Button
            disabled={!secret.trim()}
            onClick={() =>
              save(
                {
                  ...w.graph,
                  secrets: [
                    ...w.graph.secrets,
                    {
                      id: nanoid(),
                      fact: secret,
                      readerAt: readerAt || null,
                      knowledge: [],
                    },
                  ],
                },
                "secret",
              )
            }
          >
            {t.storyWorkspace.addSecret}
          </Button>
        </>
      )}
      {mode === "inbox" && (
        <>
          <h3 className="text-lg font-semibold">{t.storyWorkspace.inbox}</h3>
          <Select
            aria-label={t.storyWorkspace.inbox}
            value={noteKind}
            onChange={(e) => setNoteKind(e.target.value as typeof noteKind)}
          >
            {(["research", "fiction", "idea"] as const).map((k) => (
              <option key={k} value={k}>
                {t.storyWorkspace[k]}
              </option>
            ))}
          </Select>
          <StoryArea
            label={t.storyWorkspace.note}
            value={note}
            onChange={setNote}
          />
          <StoryArea
            label={t.storyWorkspace.source}
            value={source}
            onChange={setSource}
          />
          <NodeSelect
            w={w}
            label={t.storyWorkspace.target}
            value={at}
            onChange={setAt}
          />
          <Button
            disabled={
              !note.trim() || (noteKind === "research" && !source.trim())
            }
            onClick={() =>
              save(
                {
                  ...w.graph,
                  inbox: [
                    ...w.graph.inbox,
                    {
                      id: nanoid(),
                      kind: noteKind,
                      text: note,
                      source,
                      nodeIds: at ? [at] : [],
                      resolved: false,
                    },
                  ],
                },
                "inbox",
              )
            }
          >
            {t.storyWorkspace.add}
          </Button>
          {w.graph.inbox.map((i) => (
            <article
              className="my-4 rounded-xl border border-paper-300 p-4"
              key={i.id}
            >
              <p className="text-xs text-ink-500">
                {t.storyWorkspace[i.kind]} ·{" "}
                {i.resolved
                  ? t.storyWorkspace.resolved
                  : t.storyWorkspace.unresolved}
              </p>
              <p className="my-2 whitespace-pre-wrap text-sm">{i.text}</p>
              <p className="text-xs">
                {t.storyWorkspace.source}: {i.source || "—"}
              </p>
              {i.nodeIds.map((id) => (
                <span key={id} className="mr-3">
                  {nodeLink(id)}
                </span>
              ))}
              <div className="mt-2">
                <Button
                  size="sm"
                  onClick={() =>
                    save(
                      {
                        ...w.graph,
                        inbox: w.graph.inbox.map((x) =>
                          x.id === i.id ? { ...x, resolved: !x.resolved } : x,
                        ),
                      },
                      "inbox",
                    )
                  }
                >
                  {t.storyWorkspace.resolve}
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    save(
                      {
                        ...w.graph,
                        inbox: w.graph.inbox.filter((x) => x.id !== i.id),
                      },
                      "inbox",
                    )
                  }
                >
                  {t.storyWorkspace.remove}
                </Button>
              </div>
            </article>
          ))}
        </>
      )}
      {mode === "voice" && (
        <>
          <h3 className="text-lg font-semibold">{t.storyWorkspace.voice}</h3>
          <p className="my-3 text-sm text-ink-500">
            {t.storyWorkspace.voiceHint}
          </p>
          <p className="text-xs">
            {voice.confirmed
              ? t.storyWorkspace.confirmed
              : t.storyWorkspace.proposed}
          </p>
          {(["narration", "dialogue"] as const).map((k) => (
            <StoryArea
              key={k}
              label={t.storyWorkspace[k]}
              value={voice[k]}
              onChange={(value) =>
                setVoice({ ...voice, [k]: value, confirmed: false })
              }
            />
          ))}
          <StoryArea
            label={t.storyWorkspace.forbidden}
            value={voice.forbidden.join("\n")}
            onChange={(value) =>
              setVoice({
                ...voice,
                forbidden: value.split("\n").filter((x) => x.trim()),
                confirmed: false,
              })
            }
          />
          <h4 className="my-3 font-medium">{t.storyWorkspace.sample}</h4>
          {w.graph.anchors
            .filter((a) => a.status === "confirmed")
            .map((a) => (
              <label className="my-3 block text-sm" key={a.id}>
                <input
                  type="checkbox"
                  checked={voice.sampleAnchorIds.includes(a.id)}
                  onChange={(e) =>
                    setVoice({
                      ...voice,
                      sampleAnchorIds: e.target.checked
                        ? [...voice.sampleAnchorIds, a.id]
                        : voice.sampleAnchorIds.filter((id) => id !== a.id),
                      confirmed: false,
                    })
                  }
                />{" "}
                <q>{a.evidence.quote}</q>
              </label>
            ))}
          <Button
            onClick={() =>
              save(
                { ...w.graph, preferences: { ...voice, confirmed: true } },
                "voice",
              )
            }
          >
            {t.storyWorkspace.confirmVoice}
          </Button>
          <Button
            disabled={!w.graph.preferences.sampleAnchorIds.length}
            onClick={() =>
              act(async (signal) => {
                const result = await suggestStoryVoice(novelId, signal);
                setVoice({ ...voice, ...result, confirmed: false });
              })
            }
          >
            {t.storyWorkspace.suggestVoice}
          </Button>
        </>
      )}
      {mode === "resume" && (
        <>
          <h3 className="text-lg font-semibold">{t.storyWorkspace.resume}</h3>
          <h4 className="mb-2 mt-5 font-medium">{t.storyWorkspace.latest}</h4>
          {[...w.chapters]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 5)
            .map((c) => (
              <p key={c.id} className="my-2 text-sm">
                <Link
                  className="underline"
                  to={`/studio/${novelId}/chapters?chapter=${encodeURIComponent(c.id)}`}
                >
                  {c.chapterNo} · {c.title || t.storyWorkspace.chapter}
                </Link>{" "}
                ·{" "}
                {c.currentVersionId
                  ? t.storyWorkspace.text
                  : t.storyWorkspace.plan}
              </p>
            ))}
          <h4 className="mb-2 mt-5 font-medium">
            {t.storyWorkspace.unresolved}
          </h4>
          {w.graph.inbox
            .filter((i) => !i.resolved)
            .map((i) => (
              <p className="my-2 text-sm" key={i.id}>
                {i.text}
              </p>
            ))}
          <h4 className="mb-2 mt-5 font-medium">{t.storyWorkspace.upcoming}</h4>
          {w.cards.flatMap((c) =>
            c.kind === "thread" &&
            !established?.threads.some(
              (f) => f.threadId === c.id && f.kind === "thread_payoff",
            )
              ? [
                  <p className="my-2 text-sm" key={c.id}>
                    {c.data.title} · {c.data.progression} ·{" "}
                    {c.data.plannedChapterNo ?? t.storyWorkspace.unknown}
                  </p>,
                ]
              : [],
          )}
          <StoryArea
            label={t.storyWorkspace.question}
            value={question}
            onChange={setQuestion}
          />
          <Button
            disabled={!question.trim()}
            onClick={() =>
              act(async (signal) => {
                await discussStory(novelId, question, signal);
                reload();
              })
            }
          >
            {t.storyWorkspace.discuss}
          </Button>
          {error != null && <p role="alert">{String(error)}</p>}
          {discussions?.map((d) => (
            <section className="my-5" key={d.id}>
              <h4 className="font-medium">{d.question}</h4>
              <p className="my-2 text-xs text-ink-500">
                {t.storyWorkspace.discussionHint}
              </p>
              {d.alternatives.map((a, i) => (
                <article
                  className="my-3 rounded-xl border border-paper-300 p-4"
                  key={i}
                >
                  <h5 className="font-medium">{a.title}</h5>
                  <p className="my-2 text-sm">{a.choice}</p>
                  <p className="text-sm">
                    {t.storyWorkspace.characterEffect}: {a.characterEffect}
                  </p>
                  <p className="text-sm">
                    {t.storyWorkspace.laterEffect}: {a.laterEffect}
                  </p>
                </article>
              ))}
            </section>
          ))}
        </>
      )}
    </fieldset>
  );
}

export function StoryBranchPanel({
  novelId,
  w,
  selected,
  act,
  busy,
}: Props & { selected?: StoryNode }) {
  const [name, setName] = useState("");
  const {
    data: branches,
    error,
    reload,
  } = useAsyncData(() => listStoryBranches(novelId), {
    key: `story-branches:${novelId}`,
  });
  if (!branches || error) return <AsyncNotice error={error} retry={reload} />;
  return (
    <div className="p-6">
      <h3 className="text-lg font-semibold">{t.storyWorkspace.branches}</h3>
      <p className="my-3 text-sm text-ink-500">{t.storyWorkspace.branchHint}</p>
      <StoryField label={t.storyWorkspace.branchName}>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </StoryField>
      <Button
        disabled={busy || !name.trim() || selected?.kind !== "scene"}
        onClick={() =>
          act(() => createStoryBranch(novelId, selected!.id, name))
        }
      >
        {t.storyWorkspace.createBranch}
      </Button>
      {branches.map((b) => (
        <BranchEditor
          key={`${b.id}:${b.revision}`}
          novelId={novelId}
          w={w}
          branch={b}
          act={act}
          busy={busy}
        />
      ))}
    </div>
  );
}
function BranchEditor({
  novelId,
  w,
  branch,
  act,
  busy,
}: Props & { branch: StoryBranch }) {
  const [plan, setPlan] = useState(branch.plan),
    [sample, setSample] = useState(branch.sample),
    [instruction, setInstruction] = useState("");
  const [graph, setGraph] = useState(branch.graph),
    [target, setTarget] = useState(""),
    [reason, setReason] = useState("");
  const { data: conflicts, error } = useAsyncData(
    () => branchConflicts(novelId, branch),
    { key: `branch-conflicts:${branch.id}:${branch.revision}` },
  );
  const changed =
    JSON.stringify(plan) !== JSON.stringify(branch.plan) ||
    sample !== branch.sample ||
    JSON.stringify(graph) !== JSON.stringify(branch.graph);
  return (
    <details className="my-5 rounded-xl border border-paper-300 p-4">
      <summary className="cursor-pointer font-semibold">
        {branch.name} · {t.storyWorkspace[branch.state]}
      </summary>
      <fieldset disabled={busy || branch.state !== "draft"}>
        {(["goal", "turn", "outcome"] as const).map((key) => (
          <StoryArea
            key={key}
            label={t.storyWorkspace[key]}
            value={plan[key]}
            onChange={(value) => setPlan({ ...plan, [key]: value })}
          />
        ))}
        <p className="text-xs text-ink-500">
          {t.storyWorkspace.beforeState}: {branch.basePlan.outcome}
        </p>
        <details className="my-4">
          <summary>{t.storyWorkspace.relation}</summary>
          {graph.relations
            .filter((r) => r.from === branch.nodeId || r.to === branch.nodeId)
            .map((r) => (
              <p key={r.id} className="my-2 text-sm">
                {w.nodes.find((n) => n.id === r.from)?.title} →{" "}
                {t.storyWorkspace[r.kind]} →{" "}
                {w.nodes.find((n) => n.id === r.to)?.title} · {r.reason}
                <Button
                  size="sm"
                  onClick={() =>
                    setGraph({
                      ...graph,
                      relations: graph.relations.filter((x) => x.id !== r.id),
                    })
                  }
                >
                  {t.storyWorkspace.remove}
                </Button>
              </p>
            ))}
          <NodeSelect
            w={w}
            value={target}
            onChange={setTarget}
            label={t.storyWorkspace.target}
          />
          <StoryArea
            label={t.storyWorkspace.reason}
            value={reason}
            onChange={setReason}
          />
          <Button
            size="sm"
            disabled={!target || target === branch.nodeId || !reason.trim()}
            onClick={() =>
              setGraph({
                ...graph,
                relations: [
                  ...graph.relations,
                  {
                    id: nanoid(),
                    from: branch.nodeId,
                    to: target,
                    kind: "causes",
                    status: "confirmed",
                    reason,
                  },
                ],
              })
            }
          >
            {t.storyWorkspace.add}
          </Button>
        </details>
        <StoryArea
          label={t.storyWorkspace.sampleText}
          value={sample}
          onChange={setSample}
        />
        <Button
          disabled={!changed}
          onClick={() =>
            act(() =>
              saveStoryBranch(novelId, branch, {
                name: branch.name,
                plan,
                sample,
                graph,
              }),
            )
          }
        >
          {t.storyWorkspace.save}
        </Button>
        <StoryArea
          label={t.storyWorkspace.question}
          value={instruction}
          onChange={setInstruction}
        />
        <Button
          disabled={changed || !instruction.trim()}
          onClick={() =>
            act((signal) =>
              generateBranchSample(novelId, branch, instruction, signal),
            )
          }
        >
          {t.storyWorkspace.generateSample}
        </Button>
        <details className="my-3">
          <summary>{t.storyWorkspace.original}</summary>
          <p className="whitespace-pre-wrap text-sm">
            {branch.range
              ? branch.baseText.slice(branch.range.from, branch.range.to)
              : branch.baseText}
          </p>
        </details>
        {branch.facts.map((f, i) => (
          <blockquote
            key={i}
            className="my-3 border-l-2 border-paper-300 pl-3 text-sm"
          >
            {f.text}
            <q className="block">{f.evidence.quote}</q>
          </blockquote>
        ))}
        <h4 className="mt-4 font-medium">{t.storyWorkspace.conflicts}</h4>
        {error != null && <p role="alert">{String(error)}</p>}
        {conflicts?.map((c) => (
          <p key={c} className="text-sm text-cinnabar-600">
            {t.storyWorkspace[c as keyof typeof t.storyWorkspace] ?? c}
          </p>
        ))}
        {conflicts?.length === 0 && (
          <p className="my-2 text-sm">{t.storyWorkspace.noConflicts}</p>
        )}
        <Button
          disabled={changed || !conflicts || conflicts.length > 0}
          onClick={() => act(() => mergeStoryBranch(novelId, branch))}
        >
          {t.storyWorkspace.merge}
        </Button>
      </fieldset>
    </details>
  );
}
