import { BookOpenIcon, ListChecksIcon, RefreshCwIcon } from "lucide-react";
import { Link } from "react-router-dom";
import type { LeadKbGuidance } from "@/api/saas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function kbScopeLabel(scopeType: LeadKbGuidance["hits"][number]["scopeType"]) {
  if (scopeType === "stage") return "стадия";
  if (scopeType === "funnel") return "воронка";
  return "общая";
}

interface LeadKbGuidanceCardProps {
  guidance: LeadKbGuidance | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  className?: string;
  variant?: "card" | "section";
  onUseAction?: (action: string) => void;
  actionButtonLabel?: string;
}

export function LeadKbGuidanceCard({
  guidance,
  loading,
  error,
  onRefresh,
  className,
  variant = "card",
  onUseAction,
  actionButtonLabel = "Вставить",
}: LeadKbGuidanceCardProps) {
  const totalRequired = guidance?.requiredFields.length ?? 0;
  const filledRequired = guidance?.requiredFields.filter((field) => field.filled).length ?? 0;
  const firstHits = guidance?.hits.slice(0, 3) ?? [];
  const Wrapper = variant === "card" ? Card : "section";

  return (
    <Wrapper
      className={cn(
        variant === "section" && "rounded-lg border bg-background",
        className,
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <BookOpenIcon className="size-4 text-muted-foreground" />
          Подсказки из БЗ
        </CardTitle>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={onRefresh}
          disabled={loading}
          title="Обновить"
        >
          <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && !guidance && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        {guidance && (
          <>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">Обязательные поля</span>
                <Badge variant={filledRequired === totalRequired ? "secondary" : "outline"}>
                  {filledRequired}/{totalRequired}
                </Badge>
              </div>
              {guidance.missingRequiredFields.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {guidance.missingRequiredFields.map((field) => (
                    <Badge key={field.id} variant="outline" className="max-w-full truncate">
                      {field.displayName}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Все обязательные поля текущей стадии заполнены
                </p>
              )}
            </div>

            {guidance.warning && (
              <div className="rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
                {guidance.warning}
              </div>
            )}

            {guidance.nextActions.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <ListChecksIcon className="size-3.5 text-muted-foreground" />
                  Что сделать
                </div>
                <div className="space-y-1.5">
                  {guidance.nextActions.map((action) => (
                    <div
                      key={action}
                      className="flex items-start justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs"
                    >
                      <span className="min-w-0 leading-relaxed">{action}</span>
                      {onUseAction && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 shrink-0 px-2 text-[11px]"
                          onClick={() => onUseAction(action)}
                        >
                          {actionButtonLabel}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">Фрагменты БЗ</span>
                {guidance.stage && (
                  <Badge variant="secondary" className="max-w-[140px] truncate">
                    {guidance.stage.displayName}
                  </Badge>
                )}
              </div>
              {firstHits.length > 0 ? (
                <div className="space-y-2">
                  {firstHits.map((hit) => (
                    <div key={hit.chunkId} className="rounded-md border p-2 text-xs">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-medium">{hit.title}</span>
                        <Badge variant="outline" className="shrink-0">
                          {kbScopeLabel(hit.scopeType)}
                        </Badge>
                      </div>
                      <p className="max-h-16 overflow-hidden text-muted-foreground leading-relaxed">
                        {hit.text}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Подходящих фрагментов для текущей стадии пока нет.
                </p>
              )}
            </div>

            <Link to="/admin/faq" className="inline-flex text-xs text-primary hover:underline">
              Открыть базу знаний →
            </Link>
          </>
        )}
      </CardContent>
    </Wrapper>
  );
}
