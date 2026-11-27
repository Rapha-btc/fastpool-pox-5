"""Remap dependency principals only; retain all production bodies and guards."""
from pathlib import Path
import re, shutil, hashlib, json
here=Path(__file__).resolve().parent
root=here.parents[1]
out=here/'.build'
(out/'contracts').mkdir(parents=True,exist_ok=True)
(out/'settings').mkdir(exist_ok=True)
source=root/'contracts/fastpool-swap-vault.clar'
s=source.read_text()
bindings={
 'sbtc-token':'token','token-stx-v-1-2':'token',
 'markets-sbtc-stx-jing-v6-5':'market',
 'swap-router-sbtc-stx-jing-v6-1':'router',
 'swap-router-sbtc-stx-jing-v6':'router',
 'dia-oracle':'oracle','rfq-sbtc-stx-jing-v2-3':'oracle',
 'base-dao':'dao','ccd002-treasury-mia-rewards-v3':'treasury',
 'extension-trait':'vault-trait','juice-swap-vault-trait-v4':'vault-trait',
}
for name,target in bindings.items():
 s=re.sub(r"'S[PMT][A-Z0-9]+\."+re.escape(name)+r'(?![a-zA-Z0-9-])','.'+target,s)
s=s.replace('.signer-manager-vault-stx-rewards','.pool').replace('.juice-pool-sbtc-signer','.pool').replace('.juice-swap-vault-trait-v2.swap-vault-trait','.vault-trait.swap-vault-trait')
(out/'contracts/vault.clar').write_text(s)
names=['vault']
for p in (here/'mocks').glob('*.clar'):
 shutil.copyfile(p,out/'contracts'/p.name);names.append(p.stem)
manifest='[project]\nname="nov27-regression"\ntelemetry=false\ncache_dir=".cache"\n[repl.analysis]\npasses=[]\n'
for n in names: manifest+=f'\n[contracts.{n}]\npath="contracts/{n}.clar"\nclarity_version=6\nepoch="4.0"\n'
(out/'Clarinet.toml').write_text(manifest)
shutil.copyfile(root/'settings/Devnet.toml',out/'settings/Devnet.toml')
(out/'source-hashes.json').write_text(json.dumps({str(source.relative_to(root)):hashlib.sha256(source.read_bytes()).hexdigest()},indent=2)+'\n')
