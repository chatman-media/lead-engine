import type { Database } from "bun:sqlite";

import { QuestionnaireTokensRepo } from "../db/repos/questionnaire_tokens.ts";
import { UsersRepo } from "../db/repos/users.ts";
import { html, type RouteHandler } from "../router.ts";
import { renderForm, renderNotFound, renderSuccess } from "./template.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FormData {
  name: string;
  email: string;
  goal: string;
}

interface ValidationResult {
  values: FormData;
  errors: Record<string, string>;
}

function validate(form: URLSearchParams): ValidationResult {
  const values: FormData = {
    name: (form.get("name") ?? "").trim(),
    email: (form.get("email") ?? "").trim(),
    goal: (form.get("goal") ?? "").trim(),
  };
  const errors: Record<string, string> = {};
  if (values.name.length < 2) errors.name = "Имя слишком короткое";
  if (!EMAIL_RE.test(values.email)) errors.email = "Введите корректный email";
  if (values.goal.length < 3) errors.goal = "Опишите чуть подробнее";
  return { values, errors };
}

export function createQuestionnaireGet(db: Database): RouteHandler {
  const tokens = new QuestionnaireTokensRepo(db);
  return ({ params }) => {
    const token = params.token;
    if (!token) return html(renderNotFound(), { status: 404 });
    const valid = tokens.getValid(token);
    if (!valid) return html(renderNotFound(), { status: 404 });
    return html(renderForm({ token }));
  };
}

export function createQuestionnairePost(db: Database): RouteHandler {
  const tokens = new QuestionnaireTokensRepo(db);
  const users = new UsersRepo(db);
  return async ({ req, params }) => {
    const token = params.token;
    if (!token) return html(renderNotFound(), { status: 404 });
    if (!tokens.getValid(token)) return html(renderNotFound(), { status: 404 });

    const text = await req.text();
    const form = new URLSearchParams(text);
    const { values, errors } = validate(form);
    if (Object.keys(errors).length > 0) {
      return html(renderForm({ token, values, errors }), { status: 400 });
    }

    const userId = tokens.consume(token);
    if (!userId) return html(renderNotFound(), { status: 404 });
    users.setProfile(userId, values);
    users.setStatus(userId, "qualified");

    return html(renderSuccess());
  };
}
