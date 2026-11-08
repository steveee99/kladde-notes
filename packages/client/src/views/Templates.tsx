import { useState } from "react";
import {
  ArrowLeft,
  FilePlus2,
  LayoutTemplate,
  Pencil,
  Trash2,
} from "lucide-react";
import { PARA, Template, TEMPLATE_PLACEHOLDERS } from "@kladde/shared";
import { useVault, vault } from "../data/vault";
import { navigate } from "../lib/router";
import { useReadOnly } from "../lib/readOnly";

const newId = () =>
  `tpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Own templates for new notes (projects, meetings …); stored in the synced settings, none at first */
export function TemplatesView() {
  useVault();
  const readOnly = useReadOnly();
  const templates = vault.templates();
  const [editing, setEditing] = useState<Template | null>(null);

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex items-center gap-2 anim-fade-up">
        <button
          className="btn-icon -ml-2"
          onClick={() => navigate("/settings")}
          title="Zurück zu den Einstellungen"
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-2xl font-bold tracking-tight">Vorlagen</h1>
      </div>
      <p className="text-sm text-muted anim-fade-up">
        Vorlagen stehen beim Anlegen einer neuen Notiz zur Auswahl. Sie werden
        mit deinen Notizen verschlüsselt synchronisiert.
      </p>

      {editing ? (
        <TemplateEditor
          key={editing.id}
          template={editing}
          isNew={!templates.some((t) => t.id === editing.id)}
          onDone={() => setEditing(null)}
        />
      ) : (
        <>
          <section className="card divide-y divide-line anim-fade-up">
            {!templates.length && (
              <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted">
                <LayoutTemplate size={28} className="text-faint" />
                Noch keine Vorlagen. Lege eine an, z. B. für Projekte,
                Besprechungen oder Tagesnotizen.
              </div>
            )}
            {templates.map((t) => (
              <div key={t.id} className="flex items-center gap-3 p-4">
                <LayoutTemplate size={18} className="shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{t.label}</div>
                  <div className="truncate text-xs text-faint">
                    {t.folder || "(oberste Ebene)"}
                  </div>
                </div>
                <button
                  className="btn-icon h-8 w-8"
                  disabled={readOnly}
                  title="Bearbeiten"
                  onClick={() => setEditing(t)}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="btn-icon h-8 w-8"
                  disabled={readOnly}
                  title="Löschen"
                  onClick={() =>
                    confirm(
                      `Vorlage „${t.label}“ löschen? Bestehende Notizen bleiben unverändert.`,
                    ) && void vault.removeTemplate(t.id)
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </section>
          <button
            className="btn-primary anim-fade-up"
            disabled={readOnly}
            onClick={() =>
              setEditing({
                id: newId(),
                label: "",
                folder: PARA.inbox,
                content: "# {{title}}\n\n",
              })
            }
          >
            <FilePlus2 size={16} /> Neue Vorlage
          </button>
        </>
      )}
    </div>
  );
}

function TemplateEditor({
  template,
  isNew,
  onDone,
}: {
  template: Template;
  isNew: boolean;
  onDone: () => void;
}) {
  const [label, setLabel] = useState(template.label);
  const [folder, setFolder] = useState(template.folder);
  const [content, setContent] = useState(template.content);
  const folders = [...new Set([folder, ...vault.folders()])];

  const save = async () => {
    await vault.saveTemplate({
      id: template.id,
      label: label.trim(),
      folder,
      content,
    });
    onDone();
  };

  return (
    <form
      className="card space-y-3 p-5 anim-fade-up"
      onSubmit={(e) => {
        e.preventDefault();
        if (label.trim()) void save();
      }}
    >
      <h2 className="font-semibold">
        {isNew ? "Neue Vorlage" : "Vorlage bearbeiten"}
      </h2>
      <input
        autoFocus={isNew}
        className="input"
        placeholder="Name, z. B. Projekt"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <label className="flex items-center gap-2 text-sm text-muted">
        Ordner für neue Notizen
        <select
          className="input py-1.5"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        >
          {folders.map((f) => (
            <option key={f} value={f}>
              {f || "(oberste Ebene)"}
            </option>
          ))}
        </select>
      </label>
      <textarea
        className="input min-h-[16rem] font-mono text-sm leading-relaxed"
        spellCheck={false}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={
          "---\nstatus: aktiv\n---\n# {{title}}\n\n## Nächste Schritte\n- [ ] "
        }
      />
      <div className="text-xs text-faint">
        Platzhalter:{" "}
        {TEMPLATE_PLACEHOLDERS.map((p, i) => (
          <span key={p.token}>
            {i > 0 && " · "}
            <button
              type="button"
              className="font-mono text-muted hover:text-accent"
              title="Am Ende einfügen"
              onClick={() => setContent((c) => c + p.token)}
            >
              {p.token}
            </button>{" "}
            {p.label}
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <button className="btn-primary" disabled={!label.trim()}>
          Speichern
        </button>
        <button type="button" className="btn-ghost" onClick={onDone}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}
