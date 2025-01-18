import type { Source, VirtualFile } from "fumadocs-core/source";
import { loader } from "fumadocs-core/source";
import path from "node:path";
import { compileMDX } from "@fumadocs/mdx-remote";
import type { ReactNode } from "react";
import type { TableOfContents } from "fumadocs-core/server";
import { createMdxComponents } from "@/components/mdx";
import { meta } from "./meta";
import { remarkCompact } from "./remark-compact";
import { fetchBlob, getDocsSha, octokit, sharedConfig } from "./github";

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error(`environment variable GITHUB_TOKEN is needed.`);

const FileNameRegex = /^\d\d-(.+)$/;

export const source = loader({
  baseUrl: "/docs",
  source: await createGitHubSource(),
  slugs(info) {
    const segments = info.flattenedPath
      .split("/")
      .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
      .map((seg) => {
        const res = FileNameRegex.exec(seg);

        return res ? res[1] : seg;
      });

    if (segments.at(-1) === "index") {
      segments.pop();
    }

    return segments;
  },
});

export async function createGitHubSource(): Promise<
  Source<{
    metaData: { title: string; pages: string[] }; // Your custom type
    pageData: {
      title: string;
      load: () => Promise<{
        full?: boolean;
        source?: string;
        description?: string;

        toc: TableOfContents;
        body: ReactNode;
      }>;
    }; // Your custom type
  }>
> {
  const sha = await getDocsSha();
  if (!sha) throw new Error("Failed to find sha of docs directory");

  const out = await octokit.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    {
      ...sharedConfig,
      tree_sha: sha,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
      recursive: "true",
    },
  );

  const pages = out.data.tree.flatMap((file) => {
    if (!file.path || !file.url || file.type === "tree") return [];

    if (path.extname(file.path) === ".json") {
      console.warn(
        "We do not handle .json files at the moment, you need to hardcode them",
      );
      return [];
    }

    return {
      type: "page",
      path: file.path,
      data: {
        title: getTitleFromFile(file.path),

        async load() {
          const content = await fetchBlob(file.url as string);

          const compiled = await compileMDX({
            filePath: file.path,
            source: content,
            components: createMdxComponents(file.path!.startsWith("app")),
            mdxOptions: {
              remarkPlugins: (v) => [remarkCompact, ...v],
            },
          });

          return {
            body: compiled.content,
            toc: compiled.toc,
            ...compiled.frontmatter,
          };
        },
      },
    } satisfies VirtualFile;
  });

  return {
    files: [...pages, ...meta],
  };
}

function getTitleFromFile(file: string) {
  const parsed = path.parse(file);
  const name =
    parsed.name === "index" ? path.basename(parsed.dir) : parsed.name;

  const match = FileNameRegex.exec(name);
  const title = match ? match[1] : name;

  let upper = true;
  let out = "";
  for (const c of title) {
    if (c === "-") {
      upper = true;
      out += " ";
    } else if (upper) {
      out += c.toUpperCase();
      upper = false;
    } else {
      out += c;
    }
  }

  return out.length > 0 ? out : "Overview";
}
