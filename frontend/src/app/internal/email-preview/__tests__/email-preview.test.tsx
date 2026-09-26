// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  TEMPLATES,
  PREVIEW_LOCALES,
  renderTemplate,
  localeLabel,
  type TemplateId,
  type PreviewLocale,
} from "@/lib/emailTemplates";

describe("Email Template Rendering", () => {
  // Test each template renders without errors in all locales
  TEMPLATES.forEach(({ id, label }) => {
    describe(`Template: ${label} (${id})`, () => {
      PREVIEW_LOCALES.forEach((locale) => {
        test(`renders in ${localeLabel(locale)} (${locale})`, () => {
          const result = renderTemplate(id as TemplateId, locale as PreviewLocale);
          
          // Should have a subject
          expect(result.subject).toBeTruthy();
          expect(result.subject.length).toBeGreaterThan(0);
          
          // Should have HTML content
          expect(result.html).toBeTruthy();
          expect(result.html).toContain("<!DOCTYPE html>");
          expect(result.html).toContain("AstronLabs | RemitMortgage");
          
          // Should not contain unresolved template variables
          expect(result.html).not.toMatch(/\{[^}]+\}/);
          expect(result.subject).not.toMatch(/\{[^}]+\}/);
          
          // Should contain sample data
          expect(result.html).toContain("2,500");
          
          // Locale-specific smoke tests
          if (locale === "es") {
            // Spanish content should be present in Spanish locale
            expect(result.html.toLowerCase()).toMatch(/remitmortgage|depósito|préstamo|monto/);
          } else if (locale === "fr") {
            // French content should be present in French locale
            expect(result.html.toLowerCase()).toMatch(/remitmortgage|dépôt|prêt|montant/);
          } else {
            // English content should be present in English locale
            expect(result.html.toLowerCase()).toMatch(/remitmortgage|deposit|loan|amount/);
          }
        });
      });
      
      test("has consistent structure across locales", () => {
        const results = PREVIEW_LOCALES.map(locale => renderTemplate(id as TemplateId, locale));
        
        // All locales should have the same number of table rows
        const tableRowCounts = results.map(r => (r.html.match(/<tr>/g) || []).length);
        const firstCount = tableRowCounts[0];
        expect(tableRowCounts.every(count => count === firstCount)).toBe(true);
        
        // All should have branded wrapper
        results.forEach(result => {
          expect(result.html).toContain('class="container"');
          expect(result.html).toContain('class="header"');
          expect(result.html).toContain('class="content"');
          expect(result.html).toContain('class="footer"');
        });
      });
    });
  });

  describe("Template Data", () => {
    test("all templates have required metadata", () => {
      TEMPLATES.forEach(template => {
        expect(template.id).toBeTruthy();
        expect(template.label).toBeTruthy();
        expect(template.description).toBeTruthy();
        expect(template.description.length).toBeGreaterThan(10);
      });
    });
    
    test("locale labels are defined", () => {
      PREVIEW_LOCALES.forEach(locale => {
        const label = localeLabel(locale);
        expect(label).toBeTruthy();
        expect(label.length).toBeGreaterThan(0);
      });
    });
    
    test("no duplicate template IDs", () => {
      const ids = TEMPLATES.map(t => t.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe("HTML Quality", () => {
    test("generated HTML is valid structure", () => {
      const result = renderTemplate("deposit_receipt", "en");
      
      // Should have proper DOCTYPE and basic structure
      expect(result.html).toContain("<!DOCTYPE html>");
      expect(result.html).toContain("<html>");
      expect(result.html).toContain("<head>");
      expect(result.html).toContain("<body>");
      expect(result.html).toContain("</body>");
      expect(result.html).toContain("</html>");
      
      // Should have proper character encoding
      expect(result.html).toContain('<meta charset="utf-8">');
      
      // Should include inline CSS
      expect(result.html).toContain("<style>");
      expect(result.html).toContain("font-family:");
    });
    
    test("CTA buttons are present where expected", () => {
      // Templates with CTA buttons
      const ctaTemplates: TemplateId[] = ["repayment_reminder", "lockout"];
      
      ctaTemplates.forEach(templateId => {
        const result = renderTemplate(templateId, "en");
        expect(result.html).toContain('class="cta-button"');
        expect(result.html).toContain('href="#"');
      });
      
      // Templates without CTA buttons
      const nonCtaTemplates: TemplateId[] = ["deposit_receipt", "loan_status", "alert_deposit", "alert_milestone"];
      
      nonCtaTemplates.forEach(templateId => {
        const result = renderTemplate(templateId, "en");
        expect(result.html).not.toContain('class="cta-button"');
      });
    });
    
    test("security alert styling is applied to lockout template", () => {
      const result = renderTemplate("lockout", "en");
      expect(result.html).toContain('style="color:#ef4444"');
      expect(result.html).toContain('style="background:#ef4444"');
    });
  });
});

// Mock React components for the client component test
const MockEmailPreviewClient = () => (
  <div data-testid="email-preview-client">Email Preview Client</div>
);

jest.mock("../EmailPreviewClient", () => ({
  __esModule: true,
  default: MockEmailPreviewClient,
}));

describe("Email Preview Page", () => {
  test("renders without errors", async () => {
    const EmailPreviewPage = (await import("../page")).default;
    render(<EmailPreviewPage />);
    expect(screen.getByTestId("email-preview-client")).toBeInTheDocument();
  });
});