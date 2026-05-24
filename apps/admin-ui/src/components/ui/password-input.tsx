import { EyeIcon, EyeOffIcon } from "lucide-react";
import * as React from "react";
import { Button } from "./button";
import { Input } from "./input";

export interface PasswordInputProps
  extends Omit<React.ComponentProps<"input">, "type"> {}

/**
 * Input с переключателем видимости пароля.
 * Заменяет <Input type="password" /> везде где нужен глазик.
 */
export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);
    return (
      <div className="relative">
        <Input
          {...props}
          ref={ref}
          type={visible ? "text" : "password"}
          className={className}
          // Padding right чтобы текст не уходил под кнопку
          style={{ paddingRight: "2.5rem" }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          tabIndex={-1}
          aria-label={visible ? "Скрыть пароль" : "Показать пароль"}
          className="absolute right-0 top-0 h-full w-9 text-muted-foreground hover:text-foreground"
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
        </Button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";
