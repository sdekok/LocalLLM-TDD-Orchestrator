import * as fs from 'fs';
import * as path from 'path';

export interface EpicWorkItem {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
  security: string;
  tests: string[];
  devNotes: string;
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

    const files = fs.readdirSync(workItemsDir).filter(f => f.endsWith('.md'));
    
    // Exact filename match
    if (files.includes(query)) return path.join(workItemsDir, query);
    if (files.includes(`${query}.md`)) return path.join(workItemsDir, `${query}.md`);

    // Fuzzy match on filename (e.g., "epic-01" or "auth-system")
    const cleanQuery = query.toLowerCase().replace(/\s+/g, '-');
    const fileMatch = files.find(f => f.toLowerCase().includes(cleanQuery));
    if (fileMatch) return path.join(workItemsDir, fileMatch);

    // Deep search inside files for titles
    for (const file of files) {
      const fullPath = path.join(workItemsDir, file);
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
      
      // Extract the block for this work item (until next ### or ## header)
      const startIdx = match.index + match[0].length;
      let nextHeaderIdx = content.search(/\n(###|##)\s/);
      // search() returns index relative to start of string, but if we want it after startIdx
      const remainingContent = content.substring(startIdx);
      const nextMatch = remainingContent.match(/\n(###|##)\s/);
      const block = nextMatch ? remainingContent.substring(0, nextMatch.index) : remainingContent;

      // Extract details from block using world-class headers
      const description = block.match(/^\*\*Description\*\*:\s*(.*)/m)?.[1] || "";
      
      const acceptanceBlock = block.match(/\*\*Acceptance Criteria\*\*:\n([\s\S]*?)(?=\n\*\*|$)/i)?.[1] || "";
      const acceptance = acceptanceBlock.split('\n')
        .map(l => l.replace(/^[-*]\s*/, '').trim())
        .filter(l => l.length > 0);

      const security = block.match(/\*\*Security Considerations\*\*:\s*(.*)/m)?.[1] || "";
      
      const testsBlock = block.match(/\*\*Recommended Tests\*\*:\n([\s\S]*?)(?=\n\*\*|$)/i)?.[1] || "";
      const tests = testsBlock.split('\n')
        .map(l => l.replace(/^[-*]\s*/, '').trim())
        .filter(l => l.length > 0);

      const devNotes = block.match(/\*\*Dev Notes\*\*:\s*(.*)/m)?.[1] || "";

      workItems.push({ id, title, description, acceptance, security, tests, devNotes });
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
    const regex = new RegExp(`## ${name}\\s*([\\s\\S]*?)(?=##|$)`, 'i');
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
