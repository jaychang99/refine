import { useContext } from "react";
import { useMutation, UseMutationResult, useQueryClient } from "react-query";
import pluralize from "pluralize";
import { notification } from "antd";

import { DataContext } from "@contexts/data";
import {
    useCacheQueries,
    useCancelNotification,
    useCheckError,
    useMutationMode,
    useTranslate,
} from "@hooks";
import { ActionTypes } from "@contexts/notification";
import {
    IDataContext,
    BaseRecord,
    UpdateManyResponse,
    HttpError,
    MutationMode,
    ContextQuery,
    QueryResponse,
    Context as UpdateContext,
} from "../../interfaces";

type UseUpdateManyReturnType<
    TData extends BaseRecord = BaseRecord,
    TError extends HttpError = HttpError,
    TVariables = {},
> = UseMutationResult<
    UpdateManyResponse<TData>,
    TError,
    { ids: string[]; values: TVariables },
    UpdateContext
>;

export const useUpdateMany = <
    TData extends BaseRecord = BaseRecord,
    TError extends HttpError = HttpError,
    TVariables = {},
>(
    resource: string,
    mutationMode?: MutationMode,
    undoableTimeout?: number,
    onCancel?: (cancelMutation: () => void) => void,
): UseUpdateManyReturnType<TData, TError, TVariables> => {
    const queryClient = useQueryClient();
    const translate = useTranslate();
    const { updateMany } = useContext<IDataContext>(DataContext);
    const {
        mutationMode: mutationModeContext,
        undoableTimeout: undoableTimeoutContext,
    } = useMutationMode();
    const { mutate: checkError } = useCheckError();

    const resourceSingular = pluralize.singular(resource);

    const { notificationDispatch } = useCancelNotification();

    const mutationModePropOrContext = mutationMode ?? mutationModeContext;

    const undoableTimeoutPropOrContext =
        undoableTimeout ?? undoableTimeoutContext;

    const getAllQueries = useCacheQueries();

    const mutation = useMutation<
        UpdateManyResponse<TData>,
        TError,
        {
            ids: string[];
            values: TVariables;
        },
        UpdateContext
    >(
        ({ ids, values }: { ids: string[]; values: TVariables }) => {
            if (!(mutationModePropOrContext === "undoable")) {
                return updateMany<TData, TVariables>(resource, ids, values);
            }

            const updatePromise = new Promise<UpdateManyResponse<TData>>(
                (resolve, reject) => {
                    const updateTimeout = setTimeout(() => {
                        updateMany<TData, TVariables>(resource, ids, values)
                            .then((result) => resolve(result))
                            .catch((err) => reject(err));
                    }, undoableTimeoutPropOrContext);

                    const cancelMutation = () => {
                        clearTimeout(updateTimeout);
                        reject({ message: "mutationCancelled" });
                    };

                    if (onCancel) {
                        onCancel(cancelMutation);
                    } else {
                        notificationDispatch({
                            type: ActionTypes.ADD,
                            payload: {
                                id: ids,
                                resource: resource,
                                cancelMutation: cancelMutation,
                                seconds: undoableTimeoutPropOrContext,
                            },
                        });
                    }
                },
            );
            return updatePromise;
        },

        {
            onMutate: async (variables) => {
                const previousQueries: ContextQuery[] = [];

                const allQueries = getAllQueries(resource, variables.ids);

                for (const queryItem of allQueries) {
                    const { queryKey } = queryItem;
                    await queryClient.cancelQueries(queryKey);

                    const previousQuery =
                        queryClient.getQueryData<QueryResponse<TData>>(
                            queryKey,
                        );

                    if (!(mutationModePropOrContext === "pessimistic")) {
                        if (previousQuery) {
                            previousQueries.push({
                                query: previousQuery,
                                queryKey,
                            });

                            if (
                                queryKey.includes(`resource/list/${resource}`)
                            ) {
                                const { data } = previousQuery;

                                queryClient.setQueryData(queryKey, {
                                    ...previousQuery,
                                    data: data.map((record: TData) => {
                                        if (
                                            variables.ids.includes(record.id!)
                                        ) {
                                            return {
                                                ...record,
                                                ...variables.values,
                                            };
                                        }
                                        return record;
                                    }),
                                });
                            } else {
                                queryClient.setQueryData(queryKey, {
                                    data: {
                                        ...previousQuery.data,
                                        ...variables.values,
                                    },
                                });
                            }
                        }
                    }
                }

                return {
                    previousQueries: previousQueries,
                };
            },
            onError: (err: TError, { ids }, context) => {
                if (context) {
                    for (const query of context.previousQueries) {
                        queryClient.setQueryData(query.queryKey, query.query);
                    }
                }

                notificationDispatch({
                    type: ActionTypes.REMOVE,
                    payload: {
                        ids,
                    },
                });

                if (err.message !== "mutationCancelled") {
                    checkError?.(err);

                    notification.error({
                        key: `${ids}-${resource}-notification`,
                        message: translate(
                            "notifications.editError",
                            {
                                resource: resourceSingular,
                                statusCode: err.statusCode,
                            },
                            `Error when updating ${resourceSingular} (status code: ${err.statusCode})`,
                        ),
                        description: err.message,
                    });
                }
            },
            onSettled: (_data, _error, variables) => {
                const allQueries = getAllQueries(resource, variables.ids);
                for (const query of allQueries) {
                    queryClient.invalidateQueries(query.queryKey);
                }
            },
            onSuccess: (_data, { ids }) => {
                notification.success({
                    key: `${ids}-${resource}-notification`,
                    message: translate("notifications.success", "Successful"),
                    description: translate(
                        "notifications.editSuccess",
                        { resource: resourceSingular },
                        `Successfully updated ${resourceSingular}`,
                    ),
                });
            },
        },
    );

    return mutation;
};
