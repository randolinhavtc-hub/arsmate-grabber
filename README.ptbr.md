# Arsmate Grabber — análise de proteção de mídia e extrator de estudo

Extensão MV3 (Brave/Chrome) que enumera posts de um criador, obtém URLs
autorizadas pela própria API do site e baixa as imagens em resolução cheia.
Uso pessoal e de estudo.

## 1. Reconhecimento

`window.NUXT.config` no HTML expõe sem ofuscação:

- `apiBaseUrl` — https://arsmate.com/api
- `mediaProxyUrl` — worker Cloudflare na frente do bucket R2
- `cloudflareR2PublicUrl` — bucket privado (401 direto)

A API responde sem autenticação em `/api/creators/{username}` e
`/api/posts/feed`. O feed entrega `mediaItems[]` com `id`, `type`, `index`,
`requiresToken` e `fileName` original — mas `url: null` em tudo protegido.

## 2. Como a proteção é feita (e o que ela não é)

Não há criptografia de arquivo. Há três camadas:

1. **Blur por CSS** — o card bloqueado renderiza `thumbnail_blur.jpg` com
   filtro. A mídia real nunca entra no DOM.
2. **Checagem de Referer no proxy** — acesso direto pela barra devolve
   `Direct URL access not allowed`. Copiar o link não funciona.
3. **JWT de curta duração por objeto** — `media-secure/{JWT}/{caminho}`.
   O payload traz `sub` (caminho exato do arquivo), `postId`, `userId` e
   `exp` de 1 hora. HS256 assinado no servidor: não dá para forjar, só pedir.
   A emissão é feita por `POST /api/image/generate-token` e
   `POST /api/video/generate-token`, e depende do nível de acesso da conta.

Rotas observadas no proxy: `media-secure` (token), `media-public` e
`legacy-cdn` (público, sem token), `profile` (avatar/capa, aberto),
`video/{userId}/{mediaId}/thumbnail_blur.jpg` (preview, aberto).

## 3. Bypass

- **Referer**: regra `declarativeNetRequest` reescreve `Referer` e `Origin`
  para `https://arsmate.com` em toda request ao proxy. Sem ela, 403.
- **CORS**: os fetches rodam no service worker, amparados por
  `host_permissions`. Sem isso, a leitura do blob é bloqueada.
- **Enumeração**: paginação de `/api/posts/feed` até `hasMore: false`.
- **Autorização**: `generate-token` por post, com o `userId` da sessão.
  Download imediato, porque o token morre em 1 hora.
- **Preview**: quando a conta não alcança o post, o `thumbnail_blur.jpg`
  é salvo com sufixo `_blur` e contado separadamente.

## 4. Resultado medido

Rodada com `contentFilter=free`: 9 imagens em resolução cheia (centenas de KB
a 1,2 MB cada), 0 falhas.
Rodada com `contentFilter=all`: mesmas 9 em cheio, o restante em preview
borrado ou indisponível, com `restricted: true` e
`"Tu suscripción ha expirado"` devolvidos pela API.

## 5. Limites (honestos)

- **Conteúdo sob assinatura exige assinatura.** O gate é avaliado antes do
  objeto: com `hasAccess: false` o servidor nem consulta o arquivo. Não há
  parâmetro que contorne — testados `mediaId`, `type`, `token_id` e endpoints
  alternativos.
- `mediaId` é ignorado pelo `generate-token`: uma imagem por post. Multi-foto
  só sai pelo `url` do feed, que só existe para público.
- Posts antigos usam caminho achatado (`legacy-cdn`) e podem assinar token
  válido para objeto ausente (403 no GET).
- Vídeo é HLS: master → variante → segmentos `.ts`. O mesmo token cobre o
  prefixo, mas o Blob fica em RAM até salvar.

## 6. Reprodução

1. `brave://extensions` → Modo do desenvolvedor → Carregar sem compactação.
2. Abrir o perfil do criador, rolar a página, clicar no ícone.
3. Filtro Grátis para o acervo público; `all` para mapear a fronteira.

## 7. Estrutura

`manifest.json` · `rules.json` (regra de Referer) · `background.js`
(orquestração) · `popup.html` · `popup.js`

Conteúdo pertence aos criadores. Extensão de estudo, sem redistribuição.
