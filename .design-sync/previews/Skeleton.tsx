import { Skeleton } from "@lead-engine/admin-ui";

export function LeadRow() {
  return (
    <div className="flex w-full max-w-sm items-center gap-3 p-6">
      <Skeleton className="size-10 rounded-full" />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  );
}

export function CardBlock() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-3 p-6">
      <Skeleton className="h-32 w-full rounded-lg" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}
