import packageJson from "../package.json";

const expected = {
  electrobun: "2.0.4",
  react: "19.3.1",
  "react-dom": "19.3.1",
  typescript: "7.0.2",
  vite: "8.3.5",
  vitest: "5.0.5",
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

if (Bun.version !== "1.4.3")
  throw new Error(`Bun: expected 1.4.3, found ${Bun.version}`);
console.log("Verified direct dependency pins and Bun runtime.");
