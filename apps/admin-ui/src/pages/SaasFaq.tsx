import {
  CheckIcon,
  FileTextIcon,
  LightbulbIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { FunnelListItem, KbRequirement } from "../api/saas.ts";
import { ApiError, clearToken, type KbDoc, type KbSuggestion, saas } from "../api/saas.ts";

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
  const [funnels, setFunnels] = useState<FunnelListItem[]>([]);
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
    } catch (err) {
      if (!onAuthError(err)) setDocs([]);
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
    refreshDocs();
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
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      await saas.uploadFile(file, uploadScope());
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

  async function handleDelete(id: number) {
    try {
      await saas.deleteDoc(id);
      await Promise.all([refreshDocs(), refreshRequirements()]);
    } catch (err) {
      onAuthError(err);
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
                <span className="text-xs text-muted-foreground">.txt, .md, .json, .pdf</span>
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
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle>Материалы</CardTitle>
              <Badge variant="secondary">{docs.length}</Badge>
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
                        <p className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="secondary">{scopeLabel(d)}</Badge>
                          {d.topic && <Badge variant="outline">{d.topic}</Badge>}
                          <span className="font-mono">{d.source}</span>
                          <span>· {new Date(d.createdAt * 1000).toLocaleDateString("ru")}</span>
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
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
    </div>
  );
}
