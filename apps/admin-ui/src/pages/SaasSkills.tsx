import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, clearToken, saas, type SkillItem } from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DatabaseZapIcon, SaveIcon } from "lucide-react";
import { toast } from "sonner";

const FAMILY_LABELS: Record<string, string> = {
  cialdini: "Чалдини",
  voss: "Восс",
  nlp: "НЛП",
  sales: "Продажи",
  custom: "Кастом",
};

const FAMILY_COLORS: Record<string, string> = {
  cialdini: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  voss: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  nlp: "bg-green-500/10 text-green-600 dark:text-green-400",
  sales: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  custom: "bg-secondary text-secondary-foreground",
};

const FAMILY_ORDER = ["cialdini", "voss", "nlp", "sales", "custom"];

export function SaasSkills() {
  const navigate = useNavigate();
  const [items, setItems] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState("");
  // slug → edited prompt text
  const [editedFragments, setEditedFragments] = useState<Record<string, string>>({});
  const [savingSlug, setSavingSlug] = useState<string | null>(null);

  function load() {
    setLoading(true);
    saas
      .listSkills()
      .then((r) => setItems(r.items))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          navigate("/login", { replace: true });
        } else {
          setError("Не удалось загрузить навыки");
        }
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSeed() {
    setSeeding(true);
    try {
      const r = await saas.seedSkills();
      toast.success(`Каталог засеян: +${r.seeded} новых, ${r.updated} обновлено`);
      load();
    } catch {
      toast.error("Ошибка при засевании каталога");
    } finally {
      setSeeding(false);
    }
  }

  async function handleToggle(skill: SkillItem) {
    const newVal = !skill.isEnabled;
    // optimistic update
    setItems((prev) => prev.map((s) => (s.id === skill.id ? { ...s, isEnabled: newVal } : s)));
    try {
      await saas.updateSkill(skill.slug, { isEnabled: newVal });
    } catch {
      // rollback
      setItems((prev) => prev.map((s) => (s.id === skill.id ? { ...s, isEnabled: skill.isEnabled } : s)));
      toast.error("Не удалось обновить навык");
    }
  }

  async function handleSaveFragment(skill: SkillItem) {
    const newFragment = editedFragments[skill.slug];
    if (!newFragment) return;
    setSavingSlug(skill.slug);
    try {
      await saas.updateSkill(skill.slug, { promptFragment: newFragment });
      setItems((prev) =>
        prev.map((s) => (s.id === skill.id ? { ...s, promptFragment: newFragment } : s)),
      );
      setEditedFragments((prev) => {
        const next = { ...prev };
        delete next[skill.slug];
        return next;
      });
      toast.success("Промпт-фрагмент сохранён");
    } catch {
      toast.error("Не удалось сохранить фрагмент");
    } finally {
      setSavingSlug(null);
    }
  }

  // Sort families by canonical order
  const families = FAMILY_ORDER.filter((f) => items.some((s) => s.family === f));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Навыки убеждения"
        description="25 техник продаж — вкл/выкл и редактирование промпт-фрагментов"
      />

      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={handleSeed}
          disabled={seeding}
        >
          <DatabaseZapIcon className="mr-2 h-4 w-4" />
          {seeding ? "Засеваем…" : "Засеять каталог"}
        </Button>
        {items.length > 0 && (
          <span className="text-sm text-muted-foreground">{items.length} навыков загружено</span>
        )}
      </div>

      {loading && <p className="text-muted-foreground text-sm">Загрузка…</p>}
      {error && <p className="text-destructive text-sm">{error}</p>}

      {families.map((family) => (
        <div key={family}>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {FAMILY_LABELS[family] ?? family}
          </h3>
          <div className="grid gap-3 md:grid-cols-2">
            {items
              .filter((s) => s.family === family)
              .map((skill) => {
                const isDirty = skill.slug in editedFragments;
                const fragment = editedFragments[skill.slug] ?? skill.promptFragment;
                return (
                  <Card key={skill.id} className={skill.isEnabled ? "" : "opacity-60"}>
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-start justify-between gap-2 text-sm">
                        <span>{skill.displayName}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge
                            className={FAMILY_COLORS[skill.family] ?? "bg-secondary text-secondary-foreground"}
                            variant="outline"
                          >
                            {skill.intent}
                          </Badge>
                          <Switch
                            checked={skill.isEnabled}
                            onCheckedChange={() => handleToggle(skill)}
                          />
                        </div>
                      </CardTitle>
                      <p className="text-xs text-muted-foreground">{skill.description}</p>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <Textarea
                        value={fragment}
                        rows={3}
                        className="text-xs resize-none"
                        onChange={(e) =>
                          setEditedFragments((prev) => ({
                            ...prev,
                            [skill.slug]: e.target.value,
                          }))
                        }
                      />
                      {isDirty && (
                        <Button
                          size="sm"
                          variant="default"
                          onClick={() => handleSaveFragment(skill)}
                          disabled={savingSlug === skill.slug}
                          className="h-7 text-xs"
                        >
                          <SaveIcon className="mr-1 h-3 w-3" />
                          {savingSlug === skill.slug ? "Сохраняем…" : "Сохранить"}
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
          </div>
        </div>
      ))}

      {!loading && items.length === 0 && !error && (
        <p className="text-muted-foreground text-sm">
          Навыков пока нет. Нажмите «Засеять каталог» чтобы загрузить 25 техник.
        </p>
      )}
    </div>
  );
}
