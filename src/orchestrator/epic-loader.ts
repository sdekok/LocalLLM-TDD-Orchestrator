import * as fs from 'fs';
import * as path from 'path';
import { resolveContainedPath } from '../utils/path-safety.js';

export interface EpicWorkItem {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
  security?: string;
  tests?: string[];
  devNotes?: string;
}

export interface EpicPlan {
  title: string;
  summary: string;
  dependencies: string[];
  architecturalDecisions: string[];
  workItems: EpicWorkItem[];
  filePath: string;
}

export class EpicLoader {
  constructor(private projectDir: string) {}

  /**
   * Find an epic file by title, ID, or filename.
   */
  findEpic(query: string): string | null {
    const workItemsDir = path.join(this.projectDir, 'WorkItems');
    if (!fs.existsSync(workItemsDir)) return null;

    // Reject traversal attempts early — query must not contain path separators
    // or dot-sequences that could escape workItemsDir.
    if (query.includes('/') || query.includes('\\') || query.includes('\0')) {
      throw new Error(`Invalid query: "${query}" must not contain path separators`);
    }

    const files = fs.readdirSync(workItemsDir).filter(f => f.endsWith('.md'));

    // Exact filename match — files come from readdirSync so they are safe bare names.
    if (files.includes(query)) return resolveContainedPath(workItemsDir, query);
    if (files.includes(`${query}.md`)) return resolveContainedPath(workItemsDir, `${query}.md`);

    // Fuzzy match on filename (e.g., "epic-01" or "auth-system")
    const cleanQuery = query.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const fileMatch = files.find(f => {
      const cleanFile = f.toLowerCase().replace(/[^a-z0-9]/g, '-');
      // match "01" in "epic-01-foo.md" for query "1" or "01"
      const idMatch = f.match(/^epic-(\d+)-/);
      if (idMatch && (idMatch[1] === query || parseInt(idMatch[1]!, 10) === parseInt(query, 10))) return true;
      return cleanFile.includes(cleanQuery);
    });
    if (fileMatch) return resolveContainedPath(workItemsDir, fileMatch);

    // Deep search inside files for titles
    for (const file of files) {
      const fullPath = resolveContainedPath(workItemsDir, file);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const titleMatch = content.match(/^# Epic:\s*(.*)$/m);
      if (titleMatch && titleMatch[1]?.toLowerCase().includes(query.toLowerCase())) {
        return fullPath;
      }
    }

    return null;
  }

  /**
   * Parse a markdown epic into a structured plan.
   */
  parseEpic(filePath: string): EpicPlan {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    const title = content.match(/^# Epic:\s*(.*)$/m)?.[1] || path.basename(filePath, '.md');
    
    // Extract sections
    const summary = this.extractSection(content, 'Summary');
    const dependencies = this.extractList(content, 'Dependencies');
    const decisions = this.extractList(content, 'Architectural Decisions');
    
    // Extract work items (### WI-1: Title)
    const workItems: EpicWorkItem[] = [];
    const wiRegex = /^### (WI-\d+|[\w-]+):\s*(.*)$/gm;
    let match;
    
    while ((match = wiRegex.exec(content)) !== null) {
      const id = match[1]!;
      const title = match[2]!;
      
      // Get block until next ### header or --- divider
      const startIdx = match.index + match[0].length;
      let nextHeaderIdx = content.indexOf('\n### ', startIdx);
      const dividerIdx = content.indexOf('\n---', startIdx);
      
      if (nextHeaderIdx === -1) nextHeaderIdx = content.length;
      const endIdx = dividerIdx !== -1 && dividerIdx < nextHeaderIdx ? dividerIdx : nextHeaderIdx;
      
      const blockContent = content.substring(startIdx, endIdx).trim();
      
      // Extract sub-fields
      const descriptionMatch = blockContent.match(/\*\*Description\*\*:\s*([\s\S]*?)(?=\n\*\*|$)/i);
      const securityMatch = blockContent.match(/\*\*Security Considerations\*\*:\s*([\s\S]*?)(?=\n\*\*|$)/i);
      const devNotesMatch = blockContent.match(/\*\*Developer Notes\*\*:\s*([\s\S]*?)(?=\n\*\*|$)/i);
      
      // Extract lists
      const acceptanceMatch = blockContent.match(/\*\*Acceptance Criteria\*\*:\s*([\s\S]*?)(?=\n\*\*|$)/i);
      const testsMatch = blockContent.match(/\*\*Recommended Tests\*\*:\s*([\s\S]*?)(?=\n\*\*|$)/i);
      
      const acceptance = acceptanceMatch 
        ? acceptanceMatch[1]!.split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(l => l.length > 0)
        : [];
        
      const tests = testsMatch
        ? testsMatch[1]!.split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(l => l.length > 0)
        : [];
      
      workItems.push({ 
        id, 
        title, 
        description: descriptionMatch ? descriptionMatch[1]!.trim() : blockContent,
        acceptance,
        security: securityMatch ? securityMatch[1]!.trim() : undefined,
        tests: tests.length > 0 ? tests : undefined,
        devNotes: devNotesMatch ? devNotesMatch[1]!.trim() : undefined
      });
    }

    return {
      title,
      summary,
      dependencies,
      architecturalDecisions: decisions,
      workItems,
      filePath
    };
  }

  private extractSection(content: string, name: string): string {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`## ${escapedName}\\s*([\\s\\S]*?)(?=##|$)`, 'i');
    const match = content.match(regex);
    return match ? match[1]!.trim() : '';
  }

  private extractList(content: string, name: string): string[] {
    const section = this.extractSection(content, name);
    return section
      .split('\n')
      .map(line => line.replace(/^[-*]\s*/, '').trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  }
}
