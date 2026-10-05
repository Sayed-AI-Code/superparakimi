import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Keep the database drivers out of the bundler.
   *
   * `@electric-sql/pglite` ships a WASM build with an emscripten virtual
   * filesystem that resolves its own module paths at runtime. Bundled by
   * Turbopack those paths arrive as URL objects, and every write dies with
   * `The "path" argument must be of type string or an instance of Buffer or
   * URL. Received an instance of URL` — surfacing to users as a failed
   * `CREATE SCHEMA` on the first INSERT, i.e. "Something went wrong" on every
   * signup. Loading them as plain Node externals is what makes the
   * development backend (and therefore the Playwright smoke) work.
   *
   * `pg` and `drizzle-orm` are listed alongside so the node-postgres backend
   * used by CI is not bundled either, and the three backends stay symmetric.
   * None of this reaches the client: db/index.ts is server-only.
   */
  serverExternalPackages: ['@electric-sql/pglite', 'drizzle-orm', 'pg'],
};

export default nextConfig;
