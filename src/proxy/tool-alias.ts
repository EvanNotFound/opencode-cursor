const TO_CURSOR = new Map<string, string>([
  ["bash", "oc_bash"],
  ["read", "oc_read"],
  ["write", "oc_write"],
  ["edit", "oc_edit"],
  ["grep", "oc_grep"],
  ["glob", "oc_glob"],
  ["ls", "oc_ls"],
  ["todowrite", "oc_todowrite"],
  ["todoread", "oc_todoread"],
  ["webfetch", "oc_webfetch"],
  ["task", "oc_task"],
  ["question", "oc_question"],
  ["skill", "oc_skill"],
]);

const TO_NATIVE = new Map(Array.from(TO_CURSOR, ([native, cursor]) => [clean(cursor), native]));

export function cursorToolName(name: string): string {
  return TO_CURSOR.get(name) ?? name;
}

export function nativeToolName(name: string): string | undefined {
  return TO_NATIVE.get(clean(name));
}

function clean(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
