import type { ClientPagesLoaderOptions } from './webpack/loaders/next-client-pages-loader'
import type { MiddlewareLoaderOptions } from './webpack/loaders/next-middleware-loader'
import type { EdgeSSRLoaderQuery } from './webpack/loaders/next-edge-ssr-loader'
import type { EdgeAppRouteLoaderQuery } from './webpack/loaders/next-edge-app-route-loader'
import type { NextConfigComplete } from '../server/config-shared'
import type { webpack } from 'next/dist/compiled/webpack/webpack'
import type {
  MiddlewareConfig,
  MiddlewareMatcher,
  PageStaticInfo,
} from './analysis/get-page-static-info'
import type { LoadedEnvFiles } from '@next/env'
import type { AppLoaderOptions } from './webpack/loaders/next-app-loader'

import chalk from 'next/dist/compiled/chalk'
import { posix, join, dirname } from 'path'
import { stringify } from 'querystring'
import {
  PAGES_DIR_ALIAS,
  ROOT_DIR_ALIAS,
  APP_DIR_ALIAS,
  WEBPACK_LAYERS,
  INSTRUMENTATION_HOOK_FILENAME,
} from '../lib/constants'
import { isAPIRoute } from '../lib/is-api-route'
import { isEdgeRuntime } from '../lib/is-edge-runtime'
import { APP_CLIENT_INTERNALS, RSC_MODULE_TYPES } from '../shared/lib/constants'
import {
  CLIENT_STATIC_FILES_RUNTIME_AMP,
  CLIENT_STATIC_FILES_RUNTIME_MAIN,
  CLIENT_STATIC_FILES_RUNTIME_MAIN_APP,
  CLIENT_STATIC_FILES_RUNTIME_POLYFILLS,
  CLIENT_STATIC_FILES_RUNTIME_REACT_REFRESH,
  CompilerNameValues,
  COMPILER_NAMES,
  EDGE_RUNTIME_WEBPACK,
} from '../shared/lib/constants'
import { __ApiPreviewProps } from '../server/api-utils'
import { warn } from './output/log'
import {
  isMiddlewareFile,
  isMiddlewareFilename,
  isInstrumentationHookFile,
} from './utils'
import { getPageStaticInfo } from './analysis/get-page-static-info'
import { normalizePathSep } from '../shared/lib/page-path/normalize-path-sep'
import { normalizePagePath } from '../shared/lib/page-path/normalize-page-path'
import { ServerRuntime } from '../../types'
import { normalizeAppPath } from '../shared/lib/router/utils/app-paths'
import { encodeMatchers } from './webpack/loaders/next-middleware-loader'
import { EdgeFunctionLoaderOptions } from './webpack/loaders/next-edge-function-loader'
import { isAppRouteRoute } from '../lib/is-app-route-route'
import { normalizeMetadataRoute } from '../lib/metadata/get-metadata-route'
import { fileExists } from '../lib/file-exists'
import { getRouteLoaderEntry } from './webpack/loaders/next-route-loader'
import { isInternalComponent } from '../lib/is-internal-component'
import { isStaticMetadataRouteFile } from '../lib/metadata/is-metadata-route'

export async function getStaticInfoIncludingLayouts({
  isInsideAppDir,
  pageExtensions,
  pageFilePath,
  appDir,
  config,
  isDev,
  page,
}: {
  isInsideAppDir: boolean
  pageExtensions: string[]
  pageFilePath: string
  appDir: string | undefined
  config: NextConfigComplete
  isDev: boolean | undefined
  page: string
}): Promise<PageStaticInfo> {
  const pageStaticInfo = await getPageStaticInfo({
    nextConfig: config,
    pageFilePath,
    isDev,
    page,
    pageType: isInsideAppDir ? 'app' : 'pages',
  })

  const staticInfo: PageStaticInfo = isInsideAppDir
    ? {
        // TODO-APP: Remove the rsc key altogether. It's no longer required.
        rsc: 'server',
      }
    : pageStaticInfo

  if (isInsideAppDir && appDir) {
    const layoutFiles = []
    const potentialLayoutFiles = pageExtensions.map((ext) => 'layout.' + ext)
    let dir = dirname(pageFilePath)
    // Uses startsWith to not include directories further up.
    while (dir.startsWith(appDir)) {
      for (const potentialLayoutFile of potentialLayoutFiles) {
        const layoutFile = join(dir, potentialLayoutFile)
        if (!(await fileExists(layoutFile))) {
          continue
        }
        layoutFiles.unshift(layoutFile)
      }
      // Walk up the directory tree
      dir = join(dir, '..')
    }

    for (const layoutFile of layoutFiles) {
      const layoutStaticInfo = await getPageStaticInfo({
        nextConfig: config,
        pageFilePath: layoutFile,
        isDev,
        page,
        pageType: isInsideAppDir ? 'app' : 'pages',
      })

      // Only runtime is relevant here.
      if (layoutStaticInfo.runtime) {
        staticInfo.runtime = layoutStaticInfo.runtime
      }
      if (layoutStaticInfo.preferredRegion) {
        staticInfo.preferredRegion = layoutStaticInfo.preferredRegion
      }
    }

    if (pageStaticInfo.runtime) {
      staticInfo.runtime = pageStaticInfo.runtime
    }
    if (pageStaticInfo.preferredRegion) {
      staticInfo.preferredRegion = pageStaticInfo.preferredRegion
    }

    // if it's static metadata route, don't inherit runtime from layout
    const relativePath = pageFilePath.replace(appDir, '')
    if (isStaticMetadataRouteFile(relativePath)) {
      delete staticInfo.runtime
      delete staticInfo.preferredRegion
    }
  }
  return staticInfo
}

type ObjectValue<T> = T extends { [key: string]: infer V } ? V : never

/**
 * For a given page path removes the provided extensions.
 */
export function getPageFromPath(pagePath: string, pageExtensions: string[]) {
  let page = normalizePathSep(
    pagePath.replace(new RegExp(`\\.+(${pageExtensions.join('|')})$`), '')
  )

  page = page.replace(/\/index$/, '')

  return page === '' ? '/' : page
}

export function getPageFilePath({
  absolutePagePath,
  pagesDir,
  appDir,
  rootDir,
}: {
  absolutePagePath: string
  pagesDir: string | undefined
  appDir: string | undefined
  rootDir: string
}) {
  if (absolutePagePath.startsWith(PAGES_DIR_ALIAS) && pagesDir) {
    return absolutePagePath.replace(PAGES_DIR_ALIAS, pagesDir)
  }

  if (absolutePagePath.startsWith(APP_DIR_ALIAS) && appDir) {
    return absolutePagePath.replace(APP_DIR_ALIAS, appDir)
  }

  if (absolutePagePath.startsWith(ROOT_DIR_ALIAS)) {
    return absolutePagePath.replace(ROOT_DIR_ALIAS, rootDir)
  }

  return require.resolve(absolutePagePath)
}

export function createPagesMapping({
  isDev,
  pageExtensions,
  pagePaths,
  pagesType,
  pagesDir,
}: {
  isDev: boolean
  pageExtensions: string[]
  pagePaths: string[]
  pagesType: 'pages' | 'root' | 'app'
  pagesDir: string | undefined
}): { [page: string]: string } {
  const isAppRoute = pagesType === 'app'
  const previousPages: { [key: string]: string } = {}
  const pages = pagePaths.reduce<{ [key: string]: string }>(
    (result, pagePath) => {
      // Do not process .d.ts files inside the `pages` folder
      if (pagePath.endsWith('.d.ts') && pageExtensions.includes('ts')) {
        return result
      }

      let pageKey = getPageFromPath(pagePath, pageExtensions)
      if (isAppRoute) {
        pageKey = pageKey.replace(/%5F/g, '_')
        pageKey = pageKey.replace(/^\/not-found$/g, '/_not-found')
      }

      if (pageKey in result) {
        warn(
          `Duplicate page detected. ${chalk.cyan(
            join('pages', previousPages[pageKey])
          )} and ${chalk.cyan(
            join('pages', pagePath)
          )} both resolve to ${chalk.cyan(pageKey)}.`
        )
      } else {
        previousPages[pageKey] = pagePath
      }

      const normalizedPath = normalizePathSep(
        join(
          pagesType === 'pages'
            ? PAGES_DIR_ALIAS
            : pagesType === 'app'
            ? APP_DIR_ALIAS
            : ROOT_DIR_ALIAS,
          pagePath
        )
      )

      const route =
        pagesType === 'app' ? normalizeMetadataRoute(pageKey) : pageKey
      result[route] = normalizedPath
      return result
    },
    {}
  )

  if (pagesType !== 'pages') {
    return pages
  }

  if (isDev) {
    delete pages['/_app']
    delete pages['/_error']
    delete pages['/_document']
  }

  // In development we always alias these to allow Webpack to fallback to
  // the correct source file so that HMR can work properly when a file is
  // added or removed.
  const root = isDev && pagesDir ? PAGES_DIR_ALIAS : 'next/dist/pages'

  return {
    '/_app': `${root}/_app`,
    '/_error': `${root}/_error`,
    '/_document': `${root}/_document`,
    ...pages,
  }
}

export interface CreateEntrypointsParams {
  buildId: string
  config: NextConfigComplete
  envFiles: LoadedEnvFiles
  isDev?: boolean
  pages: { [page: string]: string }
  pagesDir?: string
  previewMode: __ApiPreviewProps
  rootDir: string
  rootPaths?: Record<string, string>
  appDir?: string
  appPaths?: Record<string, string>
  pageExtensions: string[]
  hasInstrumentationHook?: boolean
}

export function getEdgeServerEntry(opts: {
  rootDir: string
  absolutePagePath: string
  buildId: string
  bundlePath: string
  config: NextConfigComplete
  isDev: boolean
  isServerComponent: boolean
  page: string
  pages: { [page: string]: string }
  middleware?: Partial<MiddlewareConfig>
  pagesType: 'app' | 'pages' | 'root'
  appDirLoader?: string
  hasInstrumentationHook?: boolean
  preferredRegion: string | string[] | undefined
  middlewareConfig?: MiddlewareConfig
}) {
  if (
    opts.pagesType === 'app' &&
    isAppRouteRoute(opts.page) &&
    opts.appDirLoader
  ) {
    const loaderParams: EdgeAppRouteLoaderQuery = {
      absolutePagePath: opts.absolutePagePath,
      page: opts.page,
      appDirLoader: Buffer.from(opts.appDirLoader || '').toString('base64'),
      nextConfigOutput: opts.config.output,
      preferredRegion: opts.preferredRegion,
      middlewareConfig: Buffer.from(
        JSON.stringify(opts.middlewareConfig || {})
      ).toString('base64'),
    }

    return {
      import: `next-edge-app-route-loader?${stringify(loaderParams)}!`,
      layer: WEBPACK_LAYERS.server,
    }
  }
  if (isMiddlewareFile(opts.page)) {
    const loaderParams: MiddlewareLoaderOptions = {
      absolutePagePath: opts.absolutePagePath,
      page: opts.page,
      rootDir: opts.rootDir,
      matchers: opts.middleware?.matchers
        ? encodeMatchers(opts.middleware.matchers)
        : '',
      preferredRegion: opts.preferredRegion,
      middlewareConfig: Buffer.from(
        JSON.stringify(opts.middlewareConfig || {})
      ).toString('base64'),
    }

    return `next-middleware-loader?${stringify(loaderParams)}!`
  }

  if (isAPIRoute(opts.page)) {
    const loaderParams: EdgeFunctionLoaderOptions = {
      absolutePagePath: opts.absolutePagePath,
      page: opts.page,
      rootDir: opts.rootDir,
      preferredRegion: opts.preferredRegion,
      middlewareConfig: Buffer.from(
        JSON.stringify(opts.middlewareConfig || {})
      ).toString('base64'),
    }

    return `next-edge-function-loader?${stringify(loaderParams)}!`
  }

  if (isInstrumentationHookFile(opts.page)) {
    return {
      import: opts.absolutePagePath,
      filename: `edge-${INSTRUMENTATION_HOOK_FILENAME}.js`,
    }
  }

  const loaderParams: EdgeSSRLoaderQuery = {
    absolute500Path: opts.pages['/500'] || '',
    absoluteAppPath: opts.pages['/_app'],
    absoluteDocumentPath: opts.pages['/_document'],
    absoluteErrorPath: opts.pages['/_error'],
    absolutePagePath: opts.absolutePagePath,
    buildId: opts.buildId,
    dev: opts.isDev,
    isServerComponent: opts.isServerComponent,
    page: opts.page,
    stringifiedConfig: Buffer.from(JSON.stringify(opts.config)).toString(
      'base64'
    ),
    pagesType: opts.pagesType,
    appDirLoader: Buffer.from(opts.appDirLoader || '').toString('base64'),
    sriEnabled: !opts.isDev && !!opts.config.experimental.sri?.algorithm,
    incrementalCacheHandlerPath:
      opts.config.experimental.incrementalCacheHandlerPath,
    preferredRegion: opts.preferredRegion,
    middlewareConfig: Buffer.from(
      JSON.stringify(opts.middlewareConfig || {})
    ).toString('base64'),
    serverActionsBodySizeLimit:
      opts.config.experimental.serverActionsBodySizeLimit,
  }

  return {
    import: `next-edge-ssr-loader?${stringify(loaderParams)}!`,
    // The Edge bundle includes the server in its entrypoint, so it has to
    // be in the SSR layer — we later convert the page request to the RSC layer
    // via a webpack rule.
    layer: opts.appDirLoader ? WEBPACK_LAYERS.client : undefined,
  }
}

export function getAppEntry(opts: Readonly<AppLoaderOptions>) {
  return {
    import: `next-app-loader?${stringify(opts)}!`,
    layer: WEBPACK_LAYERS.server,
  }
}

export function getClientEntry(opts: {
  absolutePagePath: string
  page: string
}) {
  const loaderOptions: ClientPagesLoaderOptions = {
    absolutePagePath: opts.absolutePagePath,
    page: opts.page,
  }

  const pageLoader = `next-client-pages-loader?${stringify(loaderOptions)}!`

  // Make sure next/router is a dependency of _app or else chunk splitting
  // might cause the router to not be able to load causing hydration
  // to fail
  return opts.page === '/_app'
    ? [pageLoader, require.resolve('../client/router')]
    : pageLoader
}

export function runDependingOnPageType<T>(params: {
  onClient: () => T
  onEdgeServer: () => T
  onServer: () => T
  page: string
  pageRuntime: ServerRuntime
  pageType?: 'app' | 'pages' | 'root'
}): void {
  if (params.pageType === 'root' && isInstrumentationHookFile(params.page)) {
    params.onServer()
    params.onEdgeServer()
    return
  }

  if (isMiddlewareFile(params.page)) {
    params.onEdgeServer()
    return
  }
  if (isAPIRoute(params.page)) {
    if (isEdgeRuntime(params.pageRuntime)) {
      params.onEdgeServer()
      return
    }

    params.onServer()
    return
  }
  if (params.page === '/_document') {
    params.onServer()
    return
  }
  if (
    params.page === '/_app' ||
    params.page === '/_error' ||
    params.page === '/404' ||
    params.page === '/500'
  ) {
    params.onClient()
    params.onServer()
    return
  }
  if (isEdgeRuntime(params.pageRuntime)) {
    params.onClient()
    params.onEdgeServer()
    return
  }

  params.onClient()
  params.onServer()
  return
}

export async function createEntrypoints(
  params: CreateEntrypointsParams
): Promise<{
  client: webpack.EntryObject
  server: webpack.EntryObject
  edgeServer: webpack.EntryObject
  middlewareMatchers: undefined
}> {
  const {
    config,
    pages,
    pagesDir,
    isDev,
    rootDir,
    rootPaths,
    appDir,
    appPaths,
    pageExtensions,
  } = params
  const edgeServer: webpack.EntryObject = {}
  const server: webpack.EntryObject = {}
  const client: webpack.EntryObject = {}
  let middlewareMatchers: MiddlewareMatcher[] | undefined = undefined

  let appPathsPerRoute: Record<string, string[]> = {}
  if (appDir && appPaths) {
    for (const pathname in appPaths) {
      const normalizedPath = normalizeAppPath(pathname)
      const actualPath = appPaths[pathname]
      if (!appPathsPerRoute[normalizedPath]) {
        appPathsPerRoute[normalizedPath] = []
      }
      appPathsPerRoute[normalizedPath].push(
        // TODO-APP: refactor to pass the page path from createPagesMapping instead.
        getPageFromPath(actualPath, pageExtensions).replace(APP_DIR_ALIAS, '')
      )
    }

    // Make sure to sort parallel routes to make the result deterministic.
    appPathsPerRoute = Object.fromEntries(
      Object.entries(appPathsPerRoute).map(([k, v]) => [k, v.sort()])
    )
  }

  const getEntryHandler =
    (
      mappings: Record<string, string>,
      pagesType: 'app' | 'pages' | 'root'
    ): ((page: string) => void) =>
    async (page) => {
      const bundleFile = normalizePagePath(page)
      const clientBundlePath = posix.join(pagesType, bundleFile)
      const serverBundlePath =
        pagesType === 'pages'
          ? posix.join('pages', bundleFile)
          : pagesType === 'app'
          ? posix.join('app', bundleFile)
          : bundleFile.slice(1)
      const absolutePagePath = mappings[page]

      // Handle paths that have aliases
      const pageFilePath = getPageFilePath({
        absolutePagePath,
        pagesDir,
        appDir,
        rootDir,
      })

      const isInsideAppDir =
        !!appDir &&
        (absolutePagePath.startsWith(APP_DIR_ALIAS) ||
          absolutePagePath.startsWith(appDir))

      const staticInfo: PageStaticInfo = await getStaticInfoIncludingLayouts({
        isInsideAppDir,
        pageExtensions,
        pageFilePath,
        appDir,
        config,
        isDev,
        page,
      })

      const isServerComponent =
        isInsideAppDir && staticInfo.rsc !== RSC_MODULE_TYPES.client

      if (isMiddlewareFile(page)) {
        middlewareMatchers = staticInfo.middleware?.matchers ?? [
          { regexp: '.*', originalSource: '/:path*' },
        ]
      }

      runDependingOnPageType({
        page,
        pageRuntime: staticInfo.runtime,
        pageType: pagesType,
        onClient: () => {
          if (isServerComponent || isInsideAppDir) {
            // We skip the initial entries for server component pages and let the
            // server compiler inject them instead.
          } else {
            client[clientBundlePath] = getClientEntry({
              absolutePagePath,
              page,
            })
          }
        },
        onServer: () => {
          if (pagesType === 'app' && appDir) {
            const matchedAppPaths = appPathsPerRoute[normalizeAppPath(page)]
            server[serverBundlePath] = getAppEntry({
              page,
              name: serverBundlePath,
              pagePath: absolutePagePath,
              appDir,
              appPaths: matchedAppPaths,
              pageExtensions,
              basePath: config.basePath,
              assetPrefix: config.assetPrefix,
              nextConfigOutput: config.output,
              preferredRegion: staticInfo.preferredRegion,
              middlewareConfig: Buffer.from(
                JSON.stringify(staticInfo.middleware || {})
              ).toString('base64'),
            })
          } else if (isInstrumentationHookFile(page) && pagesType === 'root') {
            server[serverBundlePath.replace('src/', '')] = {
              import: absolutePagePath,
              // the '../' is needed to make sure the file is not chunked
              filename: `../${INSTRUMENTATION_HOOK_FILENAME}.js`,
            }
          } else if (
            !isAPIRoute(page) &&
            !isMiddlewareFile(page) &&
            !isInternalComponent(absolutePagePath)
          ) {
            server[serverBundlePath] = [
              getRouteLoaderEntry({
                page,
                pages,
                absolutePagePath,
                preferredRegion: staticInfo.preferredRegion,
                middlewareConfig: staticInfo.middleware ?? {},
              }),
            ]
          } else {
            server[serverBundlePath] = [absolutePagePath]
          }
        },
        onEdgeServer: () => {
          let appDirLoader: string = ''
          if (pagesType === 'app') {
            const matchedAppPaths = appPathsPerRoute[normalizeAppPath(page)]
            appDirLoader = getAppEntry({
              name: serverBundlePath,
              page,
              pagePath: absolutePagePath,
              appDir: appDir!,
              appPaths: matchedAppPaths,
              pageExtensions,
              basePath: config.basePath,
              assetPrefix: config.assetPrefix,
              nextConfigOutput: config.output,
              // This isn't used with edge as it needs to be set on the entry module, which will be the `edgeServerEntry` instead.
              // Still passing it here for consistency.
              preferredRegion: staticInfo.preferredRegion,
              middlewareConfig: Buffer.from(
                JSON.stringify(staticInfo.middleware || {})
              ).toString('base64'),
            }).import
          }
          const normalizedServerBundlePath =
            isInstrumentationHookFile(page) && pagesType === 'root'
              ? serverBundlePath.replace('src/', '')
              : serverBundlePath
          edgeServer[normalizedServerBundlePath] = getEdgeServerEntry({
            ...params,
            rootDir,
            absolutePagePath: absolutePagePath,
            bundlePath: clientBundlePath,
            isDev: false,
            isServerComponent,
            page,
            middleware: staticInfo?.middleware,
            pagesType,
            appDirLoader,
            preferredRegion: staticInfo.preferredRegion,
            middlewareConfig: staticInfo.middleware,
          })
        },
      })
    }

  const promises: Promise<void[]>[] = []

  if (appPaths) {
    const entryHandler = getEntryHandler(appPaths, 'app')
    promises.push(Promise.all(Object.keys(appPaths).map(entryHandler)))
  }
  if (rootPaths) {
    promises.push(
      Promise.all(
        Object.keys(rootPaths).map(getEntryHandler(rootPaths, 'root'))
      )
    )
  }
  promises.push(
    Promise.all(Object.keys(pages).map(getEntryHandler(pages, 'pages')))
  )

  await Promise.all(promises)

  return {
    client,
    server,
    edgeServer,
    middlewareMatchers,
  }
}

export function finalizeEntrypoint({
  name,
  compilerType,
  value,
  isServerComponent,
  hasAppDir,
}: {
  compilerType?: CompilerNameValues
  name: string
  value: ObjectValue<webpack.EntryObject>
  isServerComponent?: boolean
  hasAppDir?: boolean
}): ObjectValue<webpack.EntryObject> {
  const entry =
    typeof value !== 'object' || Array.isArray(value)
      ? { import: value }
      : value

  const isApi = name.startsWith('pages/api/')

  switch (compilerType) {
    case COMPILER_NAMES.server: {
      return {
        publicPath: isApi ? '' : undefined,
        runtime: isApi ? 'webpack-api-runtime' : 'webpack-runtime',
        layer: isApi
          ? WEBPACK_LAYERS.api
          : isServerComponent
          ? WEBPACK_LAYERS.server
          : undefined,
        ...entry,
      }
    }
    case COMPILER_NAMES.edgeServer: {
      return {
        layer:
          isMiddlewareFilename(name) || isApi
            ? WEBPACK_LAYERS.middleware
            : undefined,
        library: { name: ['_ENTRIES', `middleware_[name]`], type: 'assign' },
        runtime: EDGE_RUNTIME_WEBPACK,
        asyncChunks: false,
        ...entry,
      }
    }
    case COMPILER_NAMES.client: {
      const isAppLayer =
        hasAppDir &&
        (name === CLIENT_STATIC_FILES_RUNTIME_MAIN_APP ||
          name === APP_CLIENT_INTERNALS ||
          name.startsWith('app/'))

      if (
        // Client special cases
        name !== CLIENT_STATIC_FILES_RUNTIME_POLYFILLS &&
        name !== CLIENT_STATIC_FILES_RUNTIME_MAIN &&
        name !== CLIENT_STATIC_FILES_RUNTIME_MAIN_APP &&
        name !== CLIENT_STATIC_FILES_RUNTIME_AMP &&
        name !== CLIENT_STATIC_FILES_RUNTIME_REACT_REFRESH
      ) {
        if (isAppLayer) {
          return {
            dependOn: CLIENT_STATIC_FILES_RUNTIME_MAIN_APP,
            layer: WEBPACK_LAYERS.appClient,
            ...entry,
          }
        }

        return {
          dependOn:
            name.startsWith('pages/') && name !== 'pages/_app'
              ? 'pages/_app'
              : CLIENT_STATIC_FILES_RUNTIME_MAIN,
          ...entry,
        }
      }

      if (isAppLayer) {
        return {
          layer: WEBPACK_LAYERS.appClient,
          ...entry,
        }
      }

      return entry
    }
    default: {
      // Should never happen.
      throw new Error('Invalid compiler type')
    }
  }
}
