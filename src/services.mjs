import { queryVault } from './query.mjs';
import { previewRename, applyRename, updateTask, updateProperties, createFromTemplate } from './workflows.mjs';
import { healthCheck } from './workspace.mjs';
export function createServices(vault, graph) {
  return {
    updateProperties: args => updateProperties(vault,args),
    createFromTemplate: args => createFromTemplate(vault,args),
    writeDocument: args => vault.writeDocument(args.path,args.content,args.expectedRevision),
    queryVault: (query, options) => queryVault(vault, query, options),
    getTasks: ({ path, status = 'all', limit = 100, offset = 0 } = {}) => {
      const clauses = []; if (path) clauses.push(`file.path = ${JSON.stringify(path)}`);
      if (status === 'open') clauses.push('!completed'); if (status === 'completed') clauses.push('completed');
      return queryVault(vault, 'TASK' + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''), { limit, offset });
    },
    updateTask: ({ checked, ...args }) => updateTask(vault, { ...args, completed: checked }),
    renameNote: ({ from, to, dryRun = true, ...args }) => (dryRun ? previewRename : applyRename)(vault, { ...args, path: from, targetPath: to }),
    healthCheck: () => healthCheck(vault, graph)
  };
}
