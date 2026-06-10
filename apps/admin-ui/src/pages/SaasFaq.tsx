import {
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  EyeIcon,
  FileTextIcon,
  LightbulbIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { FunnelListItem, KbRequirement, StageDefinition } from "../api/saas.ts";
import {
  ApiError,
  clearToken,
  type KbDoc,
  type KbDocDetail,
  type KbDocFormat,
  type KbSearchHit,
  type KbStorageStats,
  type KbSuggestion,
  saas,
} from "../api/saas.ts";

type KbUploadScope =
  | { scopeType: "global" }
  | { scopeType: "funnel"; funnelId: number }
  | { scopeType: "stage"; funnelId: number; stageSlug: string };

/**
 * FAQ-справочник для бота: документы (RAG) и предложенные ботом Q&A.
 * Бот обменки использует это как необязательный справочник для общих вопросов
 * клиентов (часы работы, лимиты, «как без карты» и т.п.) — ядро обмена (курсы,
 * заявки, реквизиты) работает на инструментах, не на документах.
 */
export function SaasFaq() {
  const navigate = useNavigate();
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [storageStats, setStorageStats] = useState<KbStorageStats>({
    storedFiles: 0,
    totalBytes: 0,
    maxUploadBytes: 25 * 1024 * 1024,
  });
  const [funnels, setFunnels] = useState<FunnelListItem[]>([]);
  const [funnelStages, setFunnelStages] = useState<StageDefinition[]>([]);
  const [selectedFunnelId, setSelectedFunnelId] = useState<number | null>(null);
  const [requirements, setRequirements] = useState<KbRequirement[]>([]);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);

  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteBody, setPasteBody] = useState("");
  const [pasteTopic, setPasteTopic] = useState("");
  const [pasteScope, setPasteScope] = useState<KbUploadScope | null>(null);

  const [suggestions, setSuggestions] = useState<KbSuggestion[]>([]);
  const [suggestionDrafts, setSuggestionDrafts] = useState<Record<number, string>>({});
  const [decidingId, setDecidingId] = useState<number | null>(null);
  const [fileUploadNotice, setFileUploadNotice] = useState("");
  const [viewingDoc, setViewingDoc] = useState<KbDocDetail | null>(null);
  const [viewingDocId, setViewingDocId] = useState<number | null>(null);
  const [viewError, setViewError] = useState("");
  const [viewMode, setViewMode] = useState<"rendered" | "raw">("rendered");
  const [originalFileUrl, setOriginalFileUrl] = useState<string | null>(null);
  const [originalFileText, setOriginalFileText] = useState<string | null>(null);
  const [originalFileError, setOriginalFileError] = useState("");
  const [replacingOriginalId, setReplacingOriginalId] = useState<number | null>(null);
  const [reindexingDocId, setReindexingDocId] = useState<number | null>(null);
  const [kbSearchQuery, setKbSearchQuery] = useState("");
  const [kbSearchScope, setKbSearchScope] = useState<KbUploadScope | null>(null);
  const [kbSearchHits, setKbSearchHits] = useState<KbSearchHit[] | null>(null);
  const [kbSearchMode, setKbSearchMode] = useState<"hybrid" | "text" | null>(null);
  const [kbSearchError, setKbSearchError] = useState("");
  const [kbSearching, setKbSearching] = useState(false);

  useEffect(() => {
    return () => {
      if (originalFileUrl) URL.revokeObjectURL(originalFileUrl);
    };
  }, [originalFileUrl]);

  function onAuthError(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  async function refreshDocs() {
    try {
      const list = await saas.listDocs(
        selectedFunnelId ? { funnelId: selectedFunnelId } : { scopeType: "global" },
      );
      setDocs(list.items);
      setStorageStats(list.storage);
    } catch (err) {
      if (!onAuthError(err)) {
        setDocs([]);
        setStorageStats({ storedFiles: 0, totalBytes: 0, maxUploadBytes: 25 * 1024 * 1024 });
      }
    }
  }

  async function refreshFunnels() {
    try {
      const res = await saas.listFunnels();
      setFunnels(res.items);
    } catch {
      setFunnels([]);
    }
  }

  async function refreshFunnelStages() {
    if (!selectedFunnelId) {
      setFunnelStages([]);
      return;
    }
    try {
      const res = await saas.getFunnelById(selectedFunnelId);
      setFunnelStages(res.stages);
    } catch {
      setFunnelStages([]);
    }
  }

  async function refreshRequirements() {
    if (!selectedFunnelId) {
      setRequirements([]);
      return;
    }
    try {
      const res = await saas.listKbRequirements(selectedFunnelId);
      setRequirements(res.items);
    } catch {
      setRequirements([]);
    }
  }

  async function refreshSuggestions() {
    try {
      const res = await saas.listKbSuggestions(
        selectedFunnelId
          ? { status: "pending", limit: 20, funnelId: selectedFunnelId }
          : { status: "pending", limit: 20, scopeType: "global" },
      );
      setSuggestions(res.items);
      setSuggestionDrafts((prev) => {
        const next = { ...prev };
        for (const s of res.items) {
          if (!(s.id in next)) next[s.id] = s.answerDraft ?? "";
        }
        return next;
      });
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    refreshFunnels();
  }, []);

  useEffect(() => {
    setPasteScope(null);
    setKbSearchScope(null);
    setKbSearchHits(null);
    setKbSearchMode(null);
    refreshDocs();
    refreshFunnelStages();
    refreshRequirements();
    refreshSuggestions();
  }, [selectedFunnelId]);

  function defaultUploadScope(): KbUploadScope {
    return selectedFunnelId
      ? { scopeType: "funnel" as const, funnelId: selectedFunnelId }
      : { scopeType: "global" as const };
  }

  function uploadScope(): KbUploadScope {
    return pasteScope ?? defaultUploadScope();
  }

  function defaultSearchScope(): KbUploadScope {
    return defaultUploadScope();
  }

  function searchScope(): KbUploadScope {
    return kbSearchScope ?? defaultSearchScope();
  }

  function scopeValue(scope: KbUploadScope): string {
    if (scope.scopeType === "global") return "global";
    if (scope.scopeType === "funnel") return `funnel:${scope.funnelId}`;
    return `stage:${scope.funnelId}:${scope.stageSlug}`;
  }

  function parseScopeValue(value: string): KbUploadScope {
    if (value === "global") return { scopeType: "global" };
    const [type, funnelIdRaw, stageSlug] = value.split(":");
    const funnelId = Number(funnelIdRaw);
    if (type === "stage" && Number.isFinite(funnelId) && stageSlug) {
      return { scopeType: "stage", funnelId, stageSlug };
    }
    if (type === "funnel" && Number.isFinite(funnelId)) {
      return { scopeType: "funnel", funnelId };
    }
    return defaultSearchScope();
  }

  function scopeLabel(scope: {
    scopeType: KbDoc["scopeType"];
    funnelId?: number | null;
    stageSlug?: string | null;
  }): string {
    if (scope.scopeType === "global") return "общая";
    if (scope.scopeType === "stage") {
      return scope.stageSlug ? `этап ${scope.stageSlug}` : "этап";
    }
    const f = funnels.find((item) => item.id === scope.funnelId);
    return f ? f.slug : "процесс";
  }

  function indexLabel(doc: KbDoc): string {
    const count = `${doc.embeddedChunksCount}/${doc.chunksCount}`;
    switch (doc.indexStatus) {
      case "embedded":
        return `в поиске ${count}`;
      case "partial":
        return `частично ${count}`;
      case "text_only":
        return `только текст ${count}`;
      case "empty":
        return "пусто";
    }
  }

  function canReindex(doc: KbDoc): boolean {
    return doc.chunksCount > 0 && doc.indexStatus !== "embedded";
  }

  function fillRequirement(req: KbRequirement) {
    setPasteTitle(req.title);
    setPasteTopic(req.topic);
    setPasteScope(
      req.scopeType === "stage" && req.stageSlug
        ? { scopeType: "stage", funnelId: req.funnelId, stageSlug: req.stageSlug }
        : { scopeType: "funnel", funnelId: req.funnelId },
    );
    setPasteBody(
      [
        `# ${req.title}`,
        "",
        req.description,
        "",
        "Заполните конкретные правила бизнеса здесь.",
      ].join("\n"),
    );
  }

  async function handlePaste(e: FormEvent) {
    e.preventDefault();
    if (!pasteBody.trim()) return;
    setUploading(true);
    setError("");
    setFileUploadNotice("");
    try {
      await saas.uploadJson({
        title: pasteTitle.trim() || "untitled",
        body: pasteBody,
        ...(pasteTopic.trim() ? { topic: pasteTopic.trim() } : {}),
        ...uploadScope(),
      });
      setPasteTitle("");
      setPasteBody("");
      setPasteTopic("");
      setPasteScope(null);
      await Promise.all([refreshDocs(), refreshRequirements()]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        setError((err.extra?.upgradeHint as string) ?? "Лимит документов исчерпан");
      } else if (!onAuthError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = e.target.files?.[0];
    if (!file) return;
    const scope = uploadScope();
    const currentScopeLabel = scopeLabel(scope);
    setUploading(true);
    setError("");
    setFileUploadNotice(`Загружаем ${file.name} в область «${currentScopeLabel}»...`);
    try {
      await saas.uploadFile(file, scope);
      await Promise.all([refreshDocs(), refreshRequirements()]);
      setFileUploadNotice(`Загружено: ${file.name} -> «${currentScopeLabel}».`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        setError((err.extra?.upgradeHint as string) ?? "Лимит документов исчерпан");
      } else if (!onAuthError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
      setFileUploadNotice(`Не удалось загрузить: ${file.name}.`);
    } finally {
      setUploading(false);
      input.value = "";
    }
  }

  async function handleReplaceOriginal(doc: KbDoc, e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = e.target.files?.[0];
    if (!file) return;
    setReplacingOriginalId(doc.id);
    setError("");
    setFileUploadNotice(
      `${doc.hasStoredFile ? "Заменяем" : "Привязываем"} оригинал для «${doc.title}»: ${file.name}...`,
    );
    try {
      const res = await saas.replaceDocFile(doc.id, file);
      await Promise.all([refreshDocs(), refreshRequirements()]);
      setFileUploadNotice(`Оригинал обновлён: ${file.name}.`);
      if (viewingDoc?.id === doc.id) {
        await handleViewDoc(res.item);
      }
    } catch (err) {
      if (!onAuthError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
      setFileUploadNotice(`Не удалось обновить оригинал: ${file.name}.`);
    } finally {
      setReplacingOriginalId(null);
      input.value = "";
    }
  }

  async function handleReindexDoc(doc: KbDoc) {
    setReindexingDocId(doc.id);
    setError("");
    try {
      await saas.reindexDoc(doc.id);
      await Promise.all([refreshDocs(), refreshRequirements()]);
      if (viewingDoc?.id === doc.id) {
        const res = await saas.getDoc(doc.id);
        setViewingDoc(res.item);
      }
    } catch (err) {
      if (!onAuthError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setReindexingDocId(null);
    }
  }

  async function handleKbSearch(e: FormEvent) {
    e.preventDefault();
    const query = kbSearchQuery.trim();
    if (!query) return;
    setKbSearching(true);
    setKbSearchError("");
    try {
      const res = await saas.searchKb({
        query,
        limit: 5,
        ...searchScope(),
      });
      setKbSearchHits(res.items);
      setKbSearchMode(res.mode);
    } catch (err) {
      if (!onAuthError(err)) {
        setKbSearchError(err instanceof Error ? err.message : String(err));
        setKbSearchHits([]);
        setKbSearchMode(null);
      }
    } finally {
      setKbSearching(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      const shouldCloseViewer = viewingDoc?.id === id;
      await saas.deleteDoc(id);
      if (shouldCloseViewer) closeViewer();
      await Promise.all([refreshDocs(), refreshRequirements()]);
    } catch (err) {
      onAuthError(err);
    }
  }

  function closeViewer() {
    if (originalFileUrl) URL.revokeObjectURL(originalFileUrl);
    setViewingDoc(null);
    setViewError("");
    setOriginalFileUrl(null);
    setOriginalFileText(null);
    setOriginalFileError("");
  }

  async function handleViewDoc(doc: KbDoc) {
    closeViewer();
    setViewingDocId(doc.id);
    setViewError("");
    setViewMode(doc.format === "markdown" ? "rendered" : "raw");
    try {
      const res = await saas.getDoc(doc.id);
      setViewingDoc(res.item);
      setViewMode(res.item.format === "markdown" ? "rendered" : "raw");
      if (res.item.hasStoredFile) {
        try {
          const blob = await saas.getDocFile(doc.id);
          const url = URL.createObjectURL(blob);
          setOriginalFileUrl(url);
          if (res.item.format !== "pdf") {
            setOriginalFileText(await blob.text());
          }
        } catch (fileErr) {
          setOriginalFileError(fileErr instanceof Error ? fileErr.message : String(fileErr));
        }
      }
    } catch (err) {
      if (!onAuthError(err)) {
        setViewError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setViewingDocId(null);
    }
  }

  async function handleDecide(id: number, action: "approve" | "reject") {
    setDecidingId(id);
    try {
      await saas.decideKbSuggestion(id, action, {
        answerDraft: action === "approve" ? suggestionDrafts[id] : undefined,
      });
      await Promise.all([refreshSuggestions(), refreshDocs(), refreshRequirements()]);
    } catch {
      // ignore
    } finally {
      setDecidingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="База знаний"
        description="Материалы, по которым бот отвечает клиентам. Документы можно хранить общими или привязать к конкретному процессу."
      />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Область материалов</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={selectedFunnelId === null ? "default" : "outline"}
                  onClick={() => setSelectedFunnelId(null)}
                >
                  Общая база
                </Button>
                {funnels.map((funnel) => (
                  <Button
                    key={funnel.id}
                    type="button"
                    size="sm"
                    variant={selectedFunnelId === funnel.id ? "default" : "outline"}
                    onClick={() => setSelectedFunnelId(funnel.id)}
                  >
                    {funnel.slug}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>

          {selectedFunnelId && requirements.length > 0 && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle>Что желательно заполнить</CardTitle>
                <Badge variant="secondary">
                  {requirements.filter((r) => r.covered).length}/{requirements.length}
                </Badge>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {requirements.map((req) => (
                    <li key={req.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                      <span
                        className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-xs ${
                          req.covered
                            ? "border-primary bg-primary/10 text-primary"
                            : "text-muted-foreground"
                        }`}
                      >
                        {req.covered ? <CheckIcon className="size-3.5" /> : ""}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium">{req.title}</p>
                          {req.required && <Badge variant="outline">нужно</Badge>}
                          {req.stageSlug && <Badge variant="secondary">{req.stageSlug}</Badge>}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{req.description}</p>
                      </div>
                      {!req.covered && (
                        <Button size="sm" variant="outline" onClick={() => fillRequirement(req)}>
                          Заполнить
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Добавить материал</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/30 px-4 py-8 text-center transition-colors hover:border-primary/50 hover:bg-muted/50">
                <span className="grid size-10 place-items-center rounded-full bg-primary/15 text-primary">
                  <UploadIcon className="size-5" />
                </span>
                <span className="text-sm font-medium">Загрузить файл</span>
                <span className="text-xs text-muted-foreground">
                  .txt, .md, .json, .pdf · до {formatBytes(storageStats.maxUploadBytes)}
                </span>
                <span className="text-xs text-muted-foreground">оригинал сохраняется на сервере</span>
                {fileUploadNotice && (
                  <span className="max-w-full truncate text-xs text-primary">{fileUploadNotice}</span>
                )}
                <input
                  type="file"
                  accept=".txt,.md,.json,.pdf"
                  onChange={handleFileUpload}
                  disabled={uploading}
                  className="sr-only"
                />
              </label>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-card px-2 text-xs uppercase tracking-wider text-muted-foreground">
                    или вставить текст
                  </span>
                </div>
              </div>

              <form onSubmit={handlePaste} className="space-y-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Область:</span>
                  <Badge variant="secondary">{scopeLabel(uploadScope())}</Badge>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    placeholder="Заголовок (напр. «Часы работы»)"
                    value={pasteTitle}
                    onChange={(e) => setPasteTitle(e.target.value)}
                  />
                  <Input
                    placeholder="Тема (опционально)"
                    value={pasteTopic}
                    onChange={(e) => setPasteTopic(e.target.value)}
                  />
                </div>
                <Textarea
                  placeholder="Текст материала…"
                  rows={6}
                  className="font-mono text-xs"
                  value={pasteBody}
                  onChange={(e) => setPasteBody(e.target.value)}
                />
                <Button type="submit" disabled={uploading || !pasteBody.trim()}>
                  {uploading ? "Загружаем…" : "Добавить материал"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Проверка поиска</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <form onSubmit={handleKbSearch} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-[220px_1fr_auto]">
                  <select
                    value={scopeValue(searchScope())}
                    onChange={(e) => {
                      setKbSearchScope(parseScopeValue(e.target.value));
                      setKbSearchHits(null);
                      setKbSearchMode(null);
                    }}
                    className="h-10 rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="global">Общая база</option>
                    {selectedFunnelId && (
                      <option value={`funnel:${selectedFunnelId}`}>
                        Воронка {scopeLabel({ scopeType: "funnel", funnelId: selectedFunnelId })}
                      </option>
                    )}
                    {selectedFunnelId &&
                      funnelStages.map((stage) => (
                        <option key={stage.slug} value={`stage:${selectedFunnelId}:${stage.slug}`}>
                          Этап {stage.displayName}
                        </option>
                      ))}
                  </select>
                  <Input
                    placeholder="Вопрос клиента"
                    value={kbSearchQuery}
                    onChange={(e) => setKbSearchQuery(e.target.value)}
                  />
                  <Button type="submit" disabled={kbSearching || !kbSearchQuery.trim()}>
                    {kbSearching ? "Ищем…" : "Найти"}
                  </Button>
                </div>
              </form>
              {kbSearchError && <p className="text-sm text-destructive">{kbSearchError}</p>}
              {kbSearchHits && (
                <div className="space-y-3">
                  {kbSearchMode && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant={kbSearchMode === "hybrid" ? "secondary" : "outline"}>
                        {kbSearchMode === "hybrid" ? "vector + текст" : "только текст"}
                      </Badge>
                      {kbSearchMode === "text" && (
                        <span>Embeddings недоступны, поиск идёт по текстовым chunks.</span>
                      )}
                    </div>
                  )}
                  {kbSearchHits.length === 0 ? (
                    <p className="rounded-md border bg-muted/20 px-3 py-4 text-sm text-muted-foreground">
                      Ничего не найдено.
                    </p>
                  ) : (
                    kbSearchHits.map((hit) => (
                      <div key={`${hit.chunkId}-${hit.rank}`} className="rounded-md border px-3 py-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="secondary">#{hit.rank}</Badge>
                          <Badge variant="outline">{scopeLabel(hit)}</Badge>
                          <Badge variant="outline">{formatLabel(hit.format)}</Badge>
                          {hit.topic && <Badge variant="outline">{hit.topic}</Badge>}
                          <span className="font-mono">distance {formatDistance(hit.distance)}</span>
                        </div>
                        <p className="mb-1 text-sm font-medium">{hit.title}</p>
                        <p className="max-h-36 overflow-auto whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                          {hit.text}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle>Материалы</CardTitle>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Badge variant="secondary">{docs.length}</Badge>
                <Badge variant="outline">
                  {storageStats.storedFiles} оригиналов · {formatBytes(storageStats.totalBytes)}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              {docs.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Материалов пока нет. Добавьте первый ↑
                </p>
              ) : (
                <ul className="divide-y">
                  {docs.map((d) => (
                    <li key={d.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                        <FileTextIcon className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{d.title}</p>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="secondary">{scopeLabel(d)}</Badge>
                          <Badge variant="outline">{formatLabel(d.format)}</Badge>
                          <Badge variant={d.indexStatus === "embedded" ? "secondary" : "outline"}>
                            {indexLabel(d)}
                          </Badge>
                          {d.hasStoredFile && <Badge variant="outline">оригинал</Badge>}
                          {d.topic && <Badge variant="outline">{d.topic}</Badge>}
                          <span className="font-mono">{d.source}</span>
                          <span>· {new Date(d.createdAt * 1000).toLocaleDateString("ru")}</span>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-foreground"
                        disabled={viewingDocId === d.id}
                        aria-label={`Открыть документ ${d.title}`}
                        onClick={() => handleViewDoc(d)}
                      >
                        <EyeIcon className="size-4" />
                      </Button>
                      <input
                        id={`kb-original-${d.id}`}
                        type="file"
                        accept=".txt,.md,.json,.pdf"
                        className="sr-only"
                        disabled={replacingOriginalId === d.id}
                        onChange={(e) => handleReplaceOriginal(d, e)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-foreground"
                        disabled={replacingOriginalId === d.id}
                        aria-label={`${d.hasStoredFile ? "Заменить" : "Загрузить"} оригинал ${d.title}`}
                        onClick={() => document.getElementById(`kb-original-${d.id}`)?.click()}
                      >
                        <UploadIcon className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-foreground"
                        disabled={!canReindex(d) || reindexingDocId === d.id}
                        aria-label={`Переиндексировать документ ${d.title}`}
                        onClick={() => handleReindexDoc(d)}
                      >
                        <RefreshCwIcon
                          className={`size-4 ${reindexingDocId === d.id ? "animate-spin" : ""}`}
                        />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={`Удалить документ ${d.title}`}
                        onClick={() => handleDelete(d.id)}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {suggestions.length > 0 && (
          <Card className="h-fit">
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="flex items-center gap-2">
                <LightbulbIcon className="size-4 text-amber-500" />
                Предложения бота
              </CardTitle>
              <Badge variant="secondary">{suggestions.length}</Badge>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-xs text-muted-foreground">
                Вопросы клиентов, на которые у бота не было ответа. Допишите ответ и добавьте в
                справочник.
              </p>
              <ul className="divide-y">
                {suggestions.map((s) => (
                  <li key={s.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                    <p className="text-sm font-medium">{s.questionText}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.scopeType === "global"
                        ? "общая база"
                        : s.scopeType === "stage"
                          ? `этап ${s.stageSlug ?? ""}`
                          : `процесс #${s.funnelId ?? ""}`}
                    </p>
                    <textarea
                      className="min-h-[80px] w-full resize-none rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                      placeholder="Ответ для добавления в справочник…"
                      value={suggestionDrafts[s.id] ?? ""}
                      onChange={(e) =>
                        setSuggestionDrafts((prev) => ({ ...prev, [s.id]: e.target.value }))
                      }
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        disabled={decidingId === s.id || !(suggestionDrafts[s.id] ?? "").trim()}
                        onClick={() => handleDecide(s.id, "approve")}
                      >
                        <CheckIcon className="mr-1.5 size-3.5" />
                        Добавить
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={decidingId === s.id}
                        onClick={() => handleDecide(s.id, "reject")}
                      >
                        <XIcon className="mr-1.5 size-3.5" />
                        Отклонить
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={viewingDoc !== null || viewError.length > 0} onOpenChange={(open) => {
        if (!open) {
          closeViewer();
        }
      }}>
        <DialogContent className="max-h-[86vh] max-w-4xl overflow-hidden p-0">
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>{viewingDoc?.title ?? "Документ"}</DialogTitle>
          </DialogHeader>
          {viewError ? (
            <p className="px-5 py-4 text-sm text-destructive">{viewError}</p>
          ) : viewingDoc ? (
            <div className="flex max-h-[calc(86vh-76px)] flex-col">
              <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3 text-xs text-muted-foreground">
                <Badge variant="secondary">{scopeLabel(viewingDoc)}</Badge>
                <Badge variant="outline">{formatLabel(viewingDoc.format)}</Badge>
                <Badge variant={viewingDoc.indexStatus === "embedded" ? "secondary" : "outline"}>
                  {indexLabel(viewingDoc)}
                </Badge>
                {viewingDoc.hasStoredFile ? (
                  <Badge variant="outline">оригинал</Badge>
                ) : (
                  <Badge variant="outline">без оригинала</Badge>
                )}
                {viewingDoc.topic && <Badge variant="outline">{viewingDoc.topic}</Badge>}
                <span className="font-mono">{viewingDoc.source}</span>
                {viewingDoc.fileSizeBytes !== null && <span>{formatBytes(viewingDoc.fileSizeBytes)}</span>}
                {viewingDoc.hasStoredFile && originalFileUrl && (
                  <>
                    <a
                      href={originalFileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
                    >
                      <ExternalLinkIcon className="size-3.5" />
                      Открыть оригинал
                    </a>
                    <a
                      href={originalFileUrl}
                      download={viewingDoc.fileName ?? viewingDoc.title}
                      className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
                    >
                      <DownloadIcon className="size-3.5" />
                      Скачать
                    </a>
                  </>
                )}
                {viewingDoc.format === "pdf" && !viewingDoc.hasStoredFile && (
                  <span className="basis-full text-muted-foreground">
                    Старый документ: оригинальный PDF не был сохранён, показываем извлечённый текст.
                  </span>
                )}
                {originalFileError && (
                  <span className="basis-full text-destructive">{originalFileError}</span>
                )}
                {(canReindex(viewingDoc) || viewingDoc.format === "markdown") && (
                  <div className="ml-auto flex items-center gap-2">
                    {canReindex(viewingDoc) && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1.5 px-2 text-xs"
                        disabled={reindexingDocId === viewingDoc.id}
                        onClick={() => handleReindexDoc(viewingDoc)}
                      >
                        <RefreshCwIcon
                          className={`size-3.5 ${
                            reindexingDocId === viewingDoc.id ? "animate-spin" : ""
                          }`}
                        />
                        Индексировать
                      </Button>
                    )}
                    {viewingDoc.format === "markdown" && (
                      <div className="flex rounded-md border bg-background p-0.5">
                        <Button
                          type="button"
                          size="sm"
                          variant={viewMode === "rendered" ? "secondary" : "ghost"}
                          className="h-7 px-2 text-xs"
                          onClick={() => setViewMode("rendered")}
                        >
                          Просмотр
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={viewMode === "raw" ? "secondary" : "ghost"}
                          className="h-7 px-2 text-xs"
                          onClick={() => setViewMode("raw")}
                        >
                          Markdown
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {viewingDoc.format === "pdf" && originalFileUrl ? (
                <iframe
                  title={viewingDoc.title}
                  src={originalFileUrl}
                  className="min-h-[60vh] flex-1 border-0 bg-muted/20"
                />
              ) : viewingDoc.format === "markdown" && viewMode === "rendered" ? (
                <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
                  <MarkdownPreview text={originalFileText ?? viewingDoc.text} />
                </div>
              ) : (
                <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-5 py-4 font-mono text-sm leading-6">
                  {(originalFileText ?? viewingDoc.text) || "Текст документа пуст."}
                </pre>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatLabel(format: KbDocFormat): string {
  switch (format) {
    case "markdown":
      return "Markdown";
    case "pdf":
      return "PDF";
    case "json":
      return "JSON";
    case "text":
      return "Text";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDistance(distance: number): string {
  if (!Number.isFinite(distance)) return "n/a";
  return distance.toFixed(4);
}

function MarkdownPreview({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        code.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(
        <pre key={blocks.length} className="overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
          {code.join("\n")}
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const content = renderInline(heading[2]!);
      const className =
        level === 1
          ? "text-xl font-semibold"
          : level === 2
            ? "text-lg font-semibold"
            : "text-base font-semibold";
      blocks.push(
        <div key={blocks.length} className={`${className} mt-4 first:mt-0`}>
          {content}
        </div>,
      );
      i++;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={blocks.length} className="ml-5 list-disc space-y-1 text-sm leading-6">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={blocks.length} className="ml-5 list-decimal space-y-1 text-sm leading-6">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        quote.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={blocks.length} className="border-l-2 pl-3 text-sm leading-6 text-muted-foreground">
          {quote.map((part, idx) => (
            <p key={idx}>{renderInline(part)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    const paragraph: string[] = [line];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^(#{1,4})\s+/.test(lines[i] ?? "") &&
      !/^[-*]\s+/.test(lines[i] ?? "") &&
      !/^\d+\.\s+/.test(lines[i] ?? "") &&
      !/^>\s?/.test(lines[i] ?? "") &&
      !(lines[i] ?? "").startsWith("```")
    ) {
      paragraph.push(lines[i] ?? "");
      i++;
    }
    blocks.push(
      <p key={blocks.length} className="text-sm leading-6">
        {renderInline(paragraph.join(" "))}
      </p>,
    );
  }

  return <div className="space-y-3">{blocks.length > 0 ? blocks : "Текст документа пуст."}</div>;
}

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  for (const [idx, part] of parts.entries()) {
    if (!part) continue;
    if (part.startsWith("`") && part.endsWith("`")) {
      out.push(
        <code key={idx} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>,
      );
    } else if (part.startsWith("**") && part.endsWith("**")) {
      out.push(<strong key={idx}>{part.slice(2, -2)}</strong>);
    } else {
      out.push(part);
    }
  }
  return out;
}
