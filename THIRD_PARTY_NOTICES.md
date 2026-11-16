# Mastermind dependency notices

Mastermind uses the following open-source components. Their original authors retain their copyright and license terms. Product branding does not replace dependency attribution.

| Component | Purpose | License |
| --- | --- | --- |
| @babel/parser and helpers | Local source parsing | MIT |
| DOMPurify | HTML sanitization | Apache-2.0 OR MPL-2.0 |
| fflate | ZIP import and export | MIT |
| ignore | Ignore-pattern handling | MIT |
| KaTeX | Local mathematical rendering | MIT |
| marked | Markdown parsing | MIT |
| yaml | YAML parsing | ISC |
| @types/trusted-types | Dependency type declarations | MIT |

Installed packages retain their license files in `node_modules`. KaTeX fonts are served from the installed distribution with its upstream notices. Exact versions and transitive dependencies are recorded in `package-lock.json`.

The prebuilt editor includes CodeMirror and Lezer components under MIT licenses. Their full notices are included in [public/editor.LICENSE.txt](public/editor.LICENSE.txt) and must accompany the bundle when redistributed.

Development tools include the MCP SDK (MIT), Playwright (Apache-2.0), and esbuild (MIT), with their own dependency licenses. They are not required for a production-only installation.
