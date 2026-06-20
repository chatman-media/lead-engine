import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@lead-engine/admin-ui";

export function Hint() {
  return (
    <TooltipProvider>
      <div className="flex justify-center p-12">
        <Tooltip defaultOpen>
          <TooltipTrigger asChild>
            <Button variant="outline">Курс</Button>
          </TooltipTrigger>
          <TooltipContent>Курс зафиксирован на 10 минут</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
