use std::collections::HashMap;

use anyhow::{anyhow, Result};
use turbopack_binding::{
    turbo::{
        tasks::{TryJoinIterExt, Value},
        tasks_fs::FileSystemPathVc,
    },
    turbopack::{
        core::{
            chunk::{ChunkableModuleVc, ChunkingContextVc},
            compile_time_defines,
            compile_time_info::{
                CompileTimeDefines, CompileTimeDefinesVc, CompileTimeInfo, CompileTimeInfoVc,
                FreeVarReferencesVc,
            },
            context::AssetContextVc,
            environment::{BrowserEnvironment, EnvironmentVc, ExecutionEnvironment},
            file_source::FileSourceVc,
            free_var_references,
            reference_type::{EntryReferenceSubType, ReferenceType},
            resolve::{origin::PlainResolveOriginVc, parse::RequestVc},
        },
        dev::{react_refresh::assert_can_resolve_react_refresh, DevChunkingContextVc},
        dev_server::{
            html::DevHtmlAssetVc,
            source::{asset_graph::AssetGraphContentSourceVc, ContentSourceVc},
        },
        node::execution_context::ExecutionContextVc,
        turbopack::{
            ecmascript::EcmascriptModuleAssetVc, transition::TransitionsByNameVc,
            ModuleAssetContextVc,
        },
    },
};

use crate::{
    embed_js::next_js_file_path,
    mode::NextMode,
    next_client::{
        context::{get_client_resolve_options_context, ClientContextType},
        get_client_module_options_context, RuntimeEntriesVc, RuntimeEntry,
    },
    next_config::NextConfigVc,
};

fn defines() -> CompileTimeDefines {
    compile_time_defines!(
        process.turbopack = true,
        process.env.NODE_ENV = "development",
    )
}

#[turbo_tasks::function]
fn web_defines() -> CompileTimeDefinesVc {
    defines().cell()
}

#[turbo_tasks::function]
async fn web_free_vars() -> Result<FreeVarReferencesVc> {
    Ok(free_var_references!(..defines().into_iter()).cell())
}

#[turbo_tasks::function]
pub fn get_compile_time_info(browserslist_query: &str) -> CompileTimeInfoVc {
    CompileTimeInfo::builder(EnvironmentVc::new(Value::new(
        ExecutionEnvironment::Browser(
            BrowserEnvironment {
                dom: true,
                web_worker: false,
                service_worker: false,
                browserslist_query: browserslist_query.to_owned(),
            }
            .into(),
        ),
    )))
    .defines(web_defines())
    .free_var_references(web_free_vars())
    .cell()
}

#[turbo_tasks::function]
async fn get_web_runtime_entries(
    project_root: FileSystemPathVc,
    ty: Value<ClientContextType>,
    mode: NextMode,
    next_config: NextConfigVc,
    execution_context: ExecutionContextVc,
) -> Result<RuntimeEntriesVc> {
    let mut runtime_entries = vec![];

    let resolve_options_context =
        get_client_resolve_options_context(project_root, ty, mode, next_config, execution_context);
    let enable_react_refresh =
        assert_can_resolve_react_refresh(project_root, resolve_options_context)
            .await?
            .as_request();

    // It's important that React Refresh come before the regular bootstrap file,
    // because the bootstrap contains JSX which requires Refresh's global
    // functions to be available.
    if let Some(request) = enable_react_refresh {
        runtime_entries.push(RuntimeEntry::Request(request, project_root.join("_")).cell())
    };

    runtime_entries.push(
        RuntimeEntry::Source(FileSourceVc::new(next_js_file_path("dev/bootstrap.ts")).into())
            .cell(),
    );

    Ok(RuntimeEntriesVc::cell(runtime_entries))
}

// This is different from `get_client_chunking_context` as we need the assets
// to be available under a different root, otherwise we can run into conflicts.
// We don't want to have `get_client_chunking_context` depend on the
// `ClientContextType` as it's only relevant in this case, and would otherwise
// create new dev chunking contexts for no reason.
#[turbo_tasks::function]
fn get_web_client_chunking_context(
    project_path: FileSystemPathVc,
    client_root: FileSystemPathVc,
    environment: EnvironmentVc,
) -> ChunkingContextVc {
    DevChunkingContextVc::builder(
        project_path,
        client_root,
        client_root.join("_chunks"),
        client_root.join("_media"),
        environment,
    )
    .hot_module_replacement()
    .build()
    .into()
}

#[turbo_tasks::function]
fn get_web_client_asset_context(
    project_path: FileSystemPathVc,
    execution_context: ExecutionContextVc,
    compile_time_info: CompileTimeInfoVc,
    ty: Value<ClientContextType>,
    mode: NextMode,
    next_config: NextConfigVc,
) -> AssetContextVc {
    let resolve_options_context =
        get_client_resolve_options_context(project_path, ty, mode, next_config, execution_context);
    let module_options_context = get_client_module_options_context(
        project_path,
        execution_context,
        compile_time_info.environment(),
        ty,
        mode,
        next_config,
    );

    let context: AssetContextVc = ModuleAssetContextVc::new(
        TransitionsByNameVc::cell(HashMap::new()),
        compile_time_info,
        module_options_context,
        resolve_options_context,
    )
    .into();

    context
}

#[turbo_tasks::function]
pub async fn create_web_entry_source(
    project_root: FileSystemPathVc,
    execution_context: ExecutionContextVc,
    entry_requests: Vec<RequestVc>,
    client_root: FileSystemPathVc,
    eager_compile: bool,
    browserslist_query: &str,
    next_config: NextConfigVc,
) -> Result<ContentSourceVc> {
    let ty = Value::new(ClientContextType::Other);
    let mode = NextMode::Development;
    let compile_time_info = get_compile_time_info(browserslist_query);
    let context = get_web_client_asset_context(
        project_root,
        execution_context,
        compile_time_info,
        ty,
        mode,
        next_config,
    );
    let chunking_context =
        get_web_client_chunking_context(project_root, client_root, compile_time_info.environment());
    let entries = get_web_runtime_entries(project_root, ty, mode, next_config, execution_context);

    let runtime_entries = entries.resolve_entries(context);

    let origin = PlainResolveOriginVc::new(context, project_root.join("_")).as_resolve_origin();
    let entries = entry_requests
        .into_iter()
        .map(|request| async move {
            let ty = Value::new(ReferenceType::Entry(EntryReferenceSubType::Web));
            Ok(origin
                .resolve_asset(request, origin.resolve_options(ty.clone()), ty)
                .primary_assets()
                .await?
                .first()
                .copied())
        })
        .try_join()
        .await?;

    let entries: Vec<_> = entries
        .into_iter()
        .flatten()
        .map(|module| async move {
            if let Some(ecmascript) = EcmascriptModuleAssetVc::resolve_from(module).await? {
                Ok((
                    ecmascript.into(),
                    chunking_context,
                    Some(runtime_entries.with_entry(ecmascript.into())),
                ))
            } else if let Some(chunkable) = ChunkableModuleVc::resolve_from(module).await? {
                // TODO this is missing runtime code, so it's probably broken and we should also
                // add an ecmascript chunk with the runtime code
                Ok((chunkable, chunking_context, None))
            } else {
                // TODO convert into a serve-able asset
                Err(anyhow!(
                    "Entry module is not chunkable, so it can't be used to bootstrap the \
                     application"
                ))
            }
        })
        .try_join()
        .await?;

    let entry_asset = DevHtmlAssetVc::new(client_root.join("index.html"), entries).into();

    let graph = if eager_compile {
        AssetGraphContentSourceVc::new_eager(client_root, entry_asset)
    } else {
        AssetGraphContentSourceVc::new_lazy(client_root, entry_asset)
    }
    .into();
    Ok(graph)
}
