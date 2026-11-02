import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, TEST_ORG, call, createTestEnv, joinSubject, login, register, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let root: string; // super admin
before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  root = await login(env, ADMIN.username, ADMIN.password);
});
after(() => env.close());

const orgId = async () => (await env.prisma.organization.findUniqueOrThrow({ where: { name: TEST_ORG.name } })).id;
const rootId = async () => (await env.prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } })).id;

async function newOrg(name: string, _code?: string) {
  const res = await call(env, root, "POST", "/api/organizations", { name });
  assert.equal(res.statusCode, 201);
  return res.json().organization.id as string;
}
async function orgAdmin(organizationId: string, username: string) {
  const res = await call(env, root, "POST", `/api/organizations/${organizationId}/admins`, { username, password: "password-123" });
  assert.equal(res.statusCode, 201);
  return { id: res.json().admin.id as string, cookie: await login(env, username, "password-123") };
}

test("le super administrateur est intouchable", async () => {
  const oa = await orgAdmin(await orgId(), "oa-intouchable");
  const rid = await rootId();
  for (const c of [oa.cookie, root]) {
    assert.equal((await call(env, c, "POST", `/api/users/${rid}/ban`)).statusCode, 403);
    assert.equal((await call(env, c, "POST", `/api/users/${rid}/reset-password`, { newPassword: "nouveau-mdp-123" })).statusCode, 403);
  }
  assert.equal((await call(env, oa.cookie, "PUT", `/api/users/${rid}/role`, { role: "USER" })).statusCode, 404);
  assert.equal((await call(env, root, "PUT", `/api/users/${oa.id}/role`, { role: "ADMIN" })).statusCode, 404);
  assert.equal((await env.prisma.user.findUniqueOrThrow({ where: { id: rid } })).role, "ADMIN");
});

test("hiérarchie : super admin → admins d'organisation → responsables, jamais de promotion", async () => {
  const u = await register(env, "hier-joueur");
  const body = { name: "Nope" };
  assert.equal((await call(env, u.cookie, "POST", "/api/organizations", body)).statusCode, 403);

  const oid = await orgId();
  const oa = await orgAdmin(oid, "oa-hier");
  assert.equal((await call(env, oa.cookie, "POST", "/api/organizations", body)).statusCode, 403);
  const clone = { username: "oa-clone", password: "password-123" };
  assert.equal((await call(env, oa.cookie, "POST", `/api/organizations/${oid}/admins`, clone)).statusCode, 403);
  assert.equal((await call(env, u.cookie, "POST", `/api/organizations/${oid}/admins`, clone)).statusCode, 403);

  const s = await call(env, oa.cookie, "POST", "/api/subjects", { name: "Réseaux", organizationId: oid });
  assert.equal(s.statusCode, 201);
  const sid = s.json().subject.id as string;
  assert.equal((await call(env, oa.cookie, "POST", `/api/subjects/${sid}/managers`, { username: "mgr-hier", password: "password-123" })).statusCode, 201);
  const mgr = await login(env, "mgr-hier", "password-123");
  assert.equal((await call(env, mgr, "POST", "/api/subjects", { name: "Autre", organizationId: oid })).statusCode, 403);
  assert.equal((await call(env, mgr, "POST", `/api/subjects/${sid}/managers`, { username: "mgr-clone", password: "password-123" })).statusCode, 403);
  assert.equal((await call(env, oa.cookie, "PUT", `/api/subjects/${sid}/managers/${u.id}`)).statusCode, 404);
  assert.equal((await call(env, oa.cookie, "POST", `/api/subjects/${sid}/managers`, { username: "hier-joueur", password: "password-123" })).statusCode, 409);
});

test("organisations indépendantes", async () => {
  const a = await newOrg("Univ A", "univ-a");
  const b = await newOrg("Univ B", "univ-b");
  const adminA = await orgAdmin(a, "oa-a");
  const adminB = await orgAdmin(b, "oa-b");

  const sa = (await call(env, adminA.cookie, "POST", "/api/subjects", { name: "Maths", organizationId: a })).json().subject.id as string;
  const sb = (await call(env, adminB.cookie, "POST", "/api/subjects", { name: "Maths", organizationId: b })).json().subject.id as string;
  assert.notEqual(sa, sb);
  assert.equal((await call(env, adminA.cookie, "POST", "/api/subjects", { name: "Maths", organizationId: a })).statusCode, 409);
  assert.equal((await call(env, adminA.cookie, "POST", "/api/subjects", { name: "Intrus", organizationId: b })).statusCode, 403);

  assert.deepEqual((await call(env, adminA.cookie, "GET", "/api/subjects")).json().subjects.map((x: any) => x.id), [sa]);
  assert.deepEqual((await call(env, adminA.cookie, "GET", "/api/organizations")).json().organizations.map((x: any) => x.id), [a]);
  assert.equal((await call(env, adminA.cookie, "GET", `/api/subjects/${sb}`)).statusCode, 403);
  assert.equal((await call(env, adminA.cookie, "PATCH", `/api/subjects/${sb}`, { name: "Piraté" })).statusCode, 403);
  assert.equal((await call(env, adminA.cookie, "DELETE", `/api/subjects/${sb}`, { confirmName: "Maths" })).statusCode, 403);
  assert.equal((await call(env, adminA.cookie, "GET", `/api/organizations/${b}/members`)).statusCode, 403);
  assert.equal((await call(env, adminA.cookie, "PATCH", `/api/organizations/${b}`, { name: "Piraté" })).statusCode, 403);
  assert.equal((await call(env, adminA.cookie, "POST", `/api/subjects/${sb}/managers`, { username: "intrus-mgr", password: "password-123" })).statusCode, 403);

  const p = await register(env, "joueur-a");
  // clés propres à chaque matière ; l'organisation en découle
  const keys = (id: string) => ({ accessName: `cle-${id}`.toLowerCase(), accessPassword: "acces-123" });
  assert.equal((await call(env, adminA.cookie, "PATCH", `/api/subjects/${sa}`, keys(sa))).statusCode, 200);
  assert.equal((await call(env, adminB.cookie, "PATCH", `/api/subjects/${sb}`, keys(sb))).statusCode, 200);
  assert.equal((await call(env, adminA.cookie, "PATCH", `/api/subjects/${sb}`, keys(sb))).statusCode, 403);
  assert.equal((await call(env, p.cookie, "POST", "/api/subjects/join", { ...keys(sa), accessPassword: "faux-mdp" })).statusCode, 401);
  assert.equal((await call(env, p.cookie, "POST", "/api/subjects/join", keys(sa))).statusCode, 200);
  assert.equal((await call(env, p.cookie, "GET", "/api/me")).json().organizations[0].name, "Univ A");
  // une seule organisation par compte
  const refus = await call(env, p.cookie, "POST", "/api/subjects/join", keys(sb));
  assert.equal(refus.statusCode, 409);
  assert.equal(refus.json().error.code, "other_organization");
  assert.equal(await env.prisma.membership.count({ where: { userId: p.id } }), 1);
  // connaître l'organisation ne donne pas accès à ses autres matières
  const sa2 = (await call(env, adminA.cookie, "POST", "/api/subjects", { name: "Physique A", organizationId: a, accessName: "phys-a", accessPassword: "acces-123" })).json().subject.id as string;
  assert.equal((await call(env, p.cookie, "POST", `/api/me/active-subject`, { subjectId: sa2 })).statusCode, 403);
  assert.equal((await call(env, p.cookie, "POST", "/api/subjects/join", { accessName: "phys-a", accessPassword: "acces-123" })).statusCode, 200);
  assert.equal((await call(env, adminA.cookie, "POST", "/api/subjects", { name: "Doublon", organizationId: a, accessName: "phys-a", accessPassword: "acces-123" })).statusCode, 409);
});

test("un responsable n'accède qu'à ses matières", async () => {
  const oid = await newOrg("Univ C", "univ-c");
  const oa = await orgAdmin(oid, "oa-c");
  const s1 = (await call(env, oa.cookie, "POST", "/api/subjects", { name: "Algo", organizationId: oid })).json().subject.id as string;
  const s2 = (await call(env, oa.cookie, "POST", "/api/subjects", { name: "BDD", organizationId: oid })).json().subject.id as string;
  await call(env, oa.cookie, "POST", `/api/subjects/${s1}/managers`, { username: "mgr-algo", password: "password-123" });
  const m = await login(env, "mgr-algo", "password-123");

  assert.deepEqual((await call(env, m, "GET", "/api/me")).json().subjects.map((x: any) => x.id), [s1]);
  assert.deepEqual((await call(env, m, "GET", "/api/subjects")).json().subjects.map((x: any) => x.id), [s1]);
  assert.equal((await call(env, m, "GET", `/api/subjects/${s2}`)).statusCode, 403);
  assert.equal((await call(env, m, "POST", "/api/me/active-subject", { subjectId: s2 })).statusCode, 403);
  assert.equal((await call(env, m, "GET", `/api/subjects/${s2}/members`)).statusCode, 403);
  assert.equal((await call(env, m, "GET", `/api/organizations/${oid}`)).statusCode, 403);
  assert.equal((await call(env, m, "GET", "/api/organizations")).statusCode, 403);
  assert.equal((await call(env, m, "POST", "/api/subjects/join", { accessName: "x-x-x", accessPassword: "acces-123" })).statusCode, 403);
});

test("admin d'organisation : agit sur sa propre organisation seulement", async () => {
  const a = await newOrg("Univ D", "univ-d");
  const b = await newOrg("Univ E", "univ-e");
  const adminD = await orgAdmin(a, "oa-d");
  const adminE = await orgAdmin(b, "oa-e");
  const pd = await register(env, "joueur-d");
  const pe = await register(env, "joueur-e");
  const sd = (await call(env, adminD.cookie, "POST", "/api/subjects", { name: "MatD", organizationId: a })).json().subject.id as string;
  const se = (await call(env, adminE.cookie, "POST", "/api/subjects", { name: "MatE", organizationId: b })).json().subject.id as string;
  await joinSubject(env, pd.cookie, sd);
  await joinSubject(env, pe.cookie, se);

  assert.equal((await call(env, adminD.cookie, "POST", `/api/users/${pe.id}/ban`)).statusCode, 403);
  assert.equal((await call(env, adminD.cookie, "POST", `/api/users/${adminE.id}/ban`)).statusCode, 403);
  assert.equal((await call(env, adminD.cookie, "POST", `/api/users/${pd.id}/ban`)).statusCode, 200);
  assert.equal((await call(env, adminD.cookie, "POST", `/api/users/${pd.id}/unban`)).statusCode, 200);
  assert.equal((await call(env, adminD.cookie, "POST", `/api/users/${pd.id}/reset-password`, { newPassword: "nouveau-mdp-123" })).statusCode, 200);
  assert.equal((await call(env, adminD.cookie, "GET", "/api/users")).statusCode, 403);
});

test("un compte de gestion ne joue pas et n'est dans aucune liste de joueurs", async () => {
  const oid = await orgId();
  const oa = await orgAdmin(oid, "oa-nojeu");
  const s = (await call(env, oa.cookie, "POST", "/api/subjects", { name: "Sans jeu", organizationId: oid })).json().subject.id as string;
  assert.equal((await call(env, oa.cookie, "POST", "/api/subjects/join", { accessName: "k", accessPassword: "acces-123" })).statusCode, 403);
  assert.equal(await env.prisma.membership.count({ where: { user: { role: { not: "USER" } } } }), 0);
  assert.equal(await env.prisma.orgMember.count({ where: { user: { role: { not: "USER" } } } }), 0);
  const u = await register(env, "joueur-liste");
  await joinSubject(env, u.cookie, "Sans jeu");
  const members = (await call(env, oa.cookie, "GET", `/api/subjects/${s}/members`)).json().members;
  assert.deepEqual(members.map((m: any) => m.username), ["joueur-liste"]);
});

test("suppression d'une organisation : super admin, vide, nom confirmé", async () => {
  const id = await newOrg("Univ F", "univ-f");
  const oa = await orgAdmin(id, "oa-f");
  const sid = (await call(env, oa.cookie, "POST", "/api/subjects", { name: "Temp", organizationId: id })).json().subject.id as string;
  assert.equal((await call(env, oa.cookie, "DELETE", `/api/organizations/${id}`, { confirmName: "Univ F" })).statusCode, 403);
  assert.equal((await call(env, root, "DELETE", `/api/organizations/${id}`, { confirmName: "faux" })).statusCode, 422);
  assert.equal((await call(env, root, "DELETE", `/api/organizations/${id}`, { confirmName: "Univ F" })).statusCode, 409);
  assert.equal((await call(env, oa.cookie, "DELETE", `/api/subjects/${sid}`, { confirmName: "Temp" })).statusCode, 200);
  assert.equal((await call(env, root, "DELETE", `/api/organizations/${id}`, { confirmName: "Univ F" })).statusCode, 200);
});

test("réglages et apparence : propres à l'organisation / la matière, sans effet ailleurs", async () => {
  const a = await newOrg("Univ G", "univ-g");
  const b = await newOrg("Univ H", "univ-h");
  const adminG = await orgAdmin(a, "oa-g");
  const sg = (await call(env, adminG.cookie, "POST", "/api/subjects", { name: "Chimie G", organizationId: a })).json().subject.id as string;
  const sh = (await call(env, root, "POST", "/api/subjects", { name: "Chimie H", organizationId: b })).json().subject.id as string;
  await call(env, adminG.cookie, "POST", `/api/subjects/${sg}/managers`, { username: "mgr-g", password: "password-123" });
  const mgr = await login(env, "mgr-g", "password-123");

  // réglages d'organisation : seulement la sienne
  assert.equal((await call(env, adminG.cookie, "PUT", `/api/organizations/${a}/settings`, { soloQuestions: 7 })).statusCode, 200);
  assert.equal((await call(env, adminG.cookie, "PUT", `/api/organizations/${b}/settings`, { soloQuestions: 7 })).statusCode, 403);
  assert.equal((await call(env, mgr, "PUT", `/api/organizations/${a}/settings`, { soloQuestions: 9 })).statusCode, 403);
  assert.equal((await call(env, root, "GET", `/api/subjects/${sg}`)).json().settings.soloQuestions, 7);
  assert.equal((await call(env, root, "GET", `/api/subjects/${sh}`)).json().settings.soloQuestions, 10);
  // la surcharge de la matière l'emporte sur l'organisation
  await call(env, root, "PATCH", `/api/subjects/${sg}`, { settings: { soloQuestions: 12 } });
  assert.equal((await call(env, root, "GET", `/api/subjects/${sg}`)).json().settings.soloQuestions, 12);

  // apparence : organisation → ses joueurs et ses comptes ; matière → responsable
  assert.equal((await call(env, adminG.cookie, "PUT", `/api/theme/organization/${a}`, { theme: "nord" })).statusCode, 200);
  assert.equal((await call(env, adminG.cookie, "PUT", `/api/theme/organization/${b}`, { theme: "nord" })).statusCode, 403);
  assert.equal((await call(env, adminG.cookie, "PUT", `/api/theme/organization/${a}`, { theme: "inconnu" })).statusCode, 400);
  assert.equal((await call(env, mgr, "PUT", `/api/theme/organization/${a}`, { theme: "ruby" })).statusCode, 403);
  assert.equal((await call(env, mgr, "PUT", `/api/theme/subject/${sg}`, { theme: "emerald" })).statusCode, 200);
  assert.equal((await call(env, mgr, "PUT", `/api/theme/subject/${sh}`, { theme: "emerald" })).statusCode, 403);
  assert.equal((await call(env, adminG.cookie, "GET", "/api/me")).json().themeDefault, "nord");
  assert.equal((await call(env, mgr, "GET", "/api/me")).json().themeDefault, "emerald");
  const p = await register(env, "joueur-g");
  await joinSubject(env, p.cookie, sg);
  assert.equal((await call(env, p.cookie, "GET", "/api/me")).json().themeDefault, "emerald");
  await call(env, mgr, "PUT", `/api/theme/subject/${sg}`, { theme: null });
  assert.equal((await call(env, p.cookie, "GET", "/api/me")).json().themeDefault, "nord");
  const other = await register(env, "joueur-h");
  assert.equal((await call(env, other.cookie, "GET", "/api/me")).json().themeDefault ?? null, null);
});

test("tableaux de bord : plateforme pour le super admin, organisation pour son administrateur", async () => {
  const a = await newOrg("Univ S", "s");
  const b = await newOrg("Univ T", "t");
  const adminS = await orgAdmin(a, "oa-s");
  const sid = (await call(env, adminS.cookie, "POST", "/api/subjects", { name: "Stat1", organizationId: a })).json().subject.id as string;
  await call(env, adminS.cookie, "POST", "/api/subjects", { name: "Stat2", organizationId: a });
  await call(env, root, "POST", "/api/subjects", { name: "Autre", organizationId: b });
  const p = await register(env, "joueur-s");
  await joinSubject(env, p.cookie, sid);

  const org = await call(env, adminS.cookie, "GET", `/api/overview?scope=organization&organizationId=${a}&days=7`);
  assert.equal(org.statusCode, 200);
  const o = org.json();
  assert.equal(o.totals.subjects, 2);
  assert.equal(o.totals.players, 1);
  assert.equal(o.series.length, 7);
  assert.equal(o.series.reduce((n: number, d: any) => n + d.newPlayers, 0), 1);
  assert.deepEqual(o.subjects.map((s: any) => s.name).sort(), ["Stat1", "Stat2"]);
  assert.equal((await call(env, adminS.cookie, "GET", `/api/overview?scope=organization&organizationId=${b}`)).statusCode, 403);
  assert.equal((await call(env, adminS.cookie, "GET", "/api/overview?scope=platform")).statusCode, 403);
  assert.equal((await call(env, p.cookie, "GET", `/api/overview?scope=organization&organizationId=${a}`)).statusCode, 403);

  const plat = (await call(env, root, "GET", "/api/overview?scope=platform")).json();
  assert.ok(plat.totals.organizations >= 3);
  assert.ok(plat.organizations.some((x: any) => x.name === "Univ S" && x.players === 1 && x.subjects === 2));
});
