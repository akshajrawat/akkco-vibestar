import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
export default tseslint.config({ignores:['dist/**','dist-core/**','dist-electron/**','release/**','scripts/**']},js.configs.recommended,...tseslint.configs.recommended,{files:['**/*.{ts,tsx}'],rules:{'no-control-regex':'off'}},{files:['src/**/*.{ts,tsx}'],plugins:{'react-hooks':hooks},rules:{'react-hooks/rules-of-hooks':'error','react-hooks/exhaustive-deps':'warn'}});
