import { useEffect, useState } from "react";
import { saas } from "@/api/saas";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * #698 — управление сценариями симуляции из админки. Встроенные сценарии
 * редактируются (но не удаляются), кастомные — полный CRUD. Источник данных —
 * /api/admin/sim/personas (per-tenant строки sim_personas).
 */

type Persona = {
  id: string;
  name: string;
  displayName: string;
  brief: string;
  isBuiltin: boolean;
};

export function SimPersonasManager({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", displayName: "", brief: "" });

  async function reload() {
    setLoading(true);
    try {
      const r = await saas.listSimPersonas();
      setPersonas(r.personas);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      setError("");
      setEditingKey(null);
      setCreating(false);
      void reload();
    }
  }, [open]);

  function startEdit(p: Persona) {
    setCreating(false);
    setEditingKey(p.id);
    setForm({ name: p.name, displayName: p.displayName, brief: p.brief });
  }

  function startCreate() {
    setEditingKey(null);
    setCreating(true);
    setForm({ name: "", displayName: "", brief: "" });
  }

  function cancelForm() {
    setEditingKey(null);
    setCreating(false);
  }

  async function save() {
    setError("");
    const name = form.name.trim();
    const displayName = form.displayName.trim();
    const brief = form.brief.trim();
    if (!name || !displayName || !brief) {
      setError("Заполните название, имя клиента и бриф");
      return;
    }
    try {
      if (creating) {
        await saas.createSimPersona({ name, displayName, brief });
      } else if (editingKey) {
        await saas.updateSimPersona(editingKey, { name, displayName, brief });
      }
      cancelForm();
      await reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(p: Persona) {
    if (p.isBuiltin) return;
    if (!window.confirm(`Удалить сценарий «${p.name}»?`)) return;
    setError("");
    try {
      await saas.deleteSimPersona(p.id);
      await reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const editing = creating || editingKey !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-2xl overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Сценарии симуляции</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-5">
          {error && <p className="text-sm text-destructive">{error}</p>}

          {editing ? (
            <div className="space-y-2 rounded-lg border p-3">
              <Input
                placeholder="Название сценария"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
              <Input
                placeholder="Имя клиента (в инбоксе)"
                value={form.displayName}
                onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
              />
              <Textarea
                placeholder="Бриф: кого играет LLM-клиент, чего хочет, как себя ведёт…"
                rows={5}
                value={form.brief}
                onChange={(e) => setForm((f) => ({ ...f, brief: e.target.value }))}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={save}>
                  Сохранить
                </Button>
                <Button size="sm" variant="outline" onClick={cancelForm}>
                  Отмена
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" onClick={startCreate}>
              + Новый сценарий
            </Button>
          )}

          {loading ? (
            <p className="text-sm text-muted-foreground">Загрузка…</p>
          ) : (
            <div className="space-y-2">
              {personas.map((p) => (
                <div
                  key={p.id}
                  className="flex items-start justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{p.name}</span>
                      {p.isBuiltin && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          встроенный
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{p.displayName}</p>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground/80">{p.brief}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="outline" onClick={() => startEdit(p)}>
                      Изм.
                    </Button>
                    {!p.isBuiltin && (
                      <Button size="sm" variant="outline" onClick={() => remove(p)}>
                        Удал.
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
