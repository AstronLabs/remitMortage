"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState, useMemo } from "react";
import {
  TEMPLATES,
  PREVIEW_LOCALES,
  localeLabel,
  renderTemplate,
  type TemplateId,
  type PreviewLocale,
} from "@/lib/emailTemplates";

export default function EmailPreviewClient() {
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateId>("deposit_receipt");
  const [selectedLocale, setSelectedLocale] = useState<PreviewLocale>("en");
  const [viewMode, setViewMode] = useState<"preview" | "html">("preview");

  const rendered = useMemo(() => {
    return renderTemplate(selectedTemplate, selectedLocale);
  }, [selectedTemplate, selectedLocale]);

  const templateMeta = TEMPLATES.find((t) => t.id === selectedTemplate);

  return (
    <div className="min-h-screen bg-[#060913] text-slate-100">
      {/* Header */}
      <div className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <div className="flex items-center justify-between">
            <div>
              <span className="inline-block px-3 py-1 text-xs font-bold text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 rounded-full uppercase tracking-wider mb-2">
                Internal Tool
              </span>
              <h1 className="text-2xl font-bold text-white">Email Template Preview</h1>
              <p className="text-sm text-slate-400 mt-1">
                Preview transactional email templates with sample data across all supported locales.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex rounded-lg border border-slate-700 overflow-hidden">
                <button
                  onClick={() => setViewMode("preview")}
                  className={`px-3 py-2 text-xs font-semibold transition-colors ${
                    viewMode === "preview"
                      ? "bg-cyan-500 text-white"
                      : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  Preview
                </button>
                <button
                  onClick={() => setViewMode("html")}
                  className={`px-3 py-2 text-xs font-semibold transition-colors ${
                    viewMode === "html"
                      ? "bg-cyan-500 text-white"
                      : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  HTML Source
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-8">
          {/* Sidebar Controls */}
          <div className="space-y-6">
            {/* Template Selector */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-5">
              <h3 className="text-sm font-bold text-white mb-3">Template</h3>
              <div className="space-y-2">
                {TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    onClick={() => setSelectedTemplate(template.id)}
                    className={`w-full text-left p-3 rounded-lg border transition-all ${
                      selectedTemplate === template.id
                        ? "border-cyan-500 bg-cyan-500/10 text-white"
                        : "border-slate-700 bg-slate-800/50 text-slate-300 hover:border-slate-600 hover:bg-slate-800"
                    }`}
                  >
                    <div className="font-semibold text-xs mb-1">{template.label}</div>
                    <div className="text-xs text-slate-400 leading-relaxed">
                      {template.description}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Locale Selector */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-5">
              <h3 className="text-sm font-bold text-white mb-3">Locale</h3>
              <div className="space-y-2">
                {PREVIEW_LOCALES.map((locale) => (
                  <button
                    key={locale}
                    onClick={() => setSelectedLocale(locale)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                      selectedLocale === locale
                        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                        : "bg-slate-800/50 text-slate-300 hover:bg-slate-700 border border-slate-700"
                    }`}
                  >
                    <span className="font-mono text-xs">{locale.toUpperCase()}</span>
                    <span className="ml-2">{localeLabel(locale)}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Template Info */}
            {templateMeta && (
              <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-5">
                <h3 className="text-sm font-bold text-white mb-2">Template Info</h3>
                <div className="space-y-2 text-xs">
                  <div>
                    <span className="text-slate-400">ID:</span>
                    <span className="ml-2 font-mono text-cyan-300">{templateMeta.id}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">Locale:</span>
                    <span className="ml-2 font-mono text-emerald-300">{selectedLocale}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">Subject:</span>
                    <div className="mt-1 p-2 bg-slate-800 rounded border border-slate-700 font-mono text-slate-200 text-xs break-words">
                      {rendered.subject}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Preview Area */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-lg overflow-hidden">
            <div className="border-b border-slate-800 p-4 bg-slate-900/60">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-white">
                  {templateMeta?.label} — {localeLabel(selectedLocale)}
                </h2>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span>View:</span>
                  <span className="font-mono text-cyan-300">{viewMode}</span>
                </div>
              </div>
            </div>

            <div className="p-6">
              {viewMode === "preview" ? (
                <div className="bg-white rounded-lg overflow-hidden shadow-lg">
                  <iframe
                    srcDoc={rendered.html}
                    className="w-full h-[600px] border-0"
                    title="Email Preview"
                    sandbox="allow-same-origin"
                  />
                </div>
              ) : (
                <div className="bg-slate-950 border border-slate-700 rounded-lg p-4 overflow-x-auto">
                  <pre className="text-xs text-slate-300 font-mono whitespace-pre-wrap break-words">
                    {rendered.html}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}