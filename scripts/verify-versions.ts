import packageJson from "../package.json";

const expected = {
  electrobun: "1.18.1",
  "ghostty-web": "0.4.0",
  react: "19.3.0",
  "react-dom": "19.3.0",
  typescript: "7.0.2",
  vite: "8.3.0",
  vitest: "5.0.0",
} as const;

for (const [name, version] of Object.entries(expected)) {
  const actual =
    packageJson.dependencies?.[name as keyof typeof packageJson.dependencies] ||
    packageJson.devDependencies?.[
      name as keyof typeof packageJson.devDependencies
    ];
  if (actual !== version)
    throw new Error(
      `${name}: expected exact ${version}, found ${actual || "missing"}`,
    );
}

if (Bun.version !== "1.4.2")
  throw new Error(`Bun: expected 1.4.2, found ${Bun.version}`);
console.log("Verified direct dependency pins and Bun runtime.");
