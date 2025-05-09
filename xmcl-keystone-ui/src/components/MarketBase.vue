<template>
  <div
    class="relative flex h-full select-none flex-col overflow-auto pb-0 market-base"
    style="box-sizing: border-box"
    @wheel.stop
  >
    <v-progress-linear
      class="absolute left-0 top-0 z-20 m-0 p-0"
      :active="loading"
      height="3"
      :indeterminate="true"
    />
    <SplitPane
      flex-left
      :min-percent="30"
      :default-percent="30"
      class="flex h-full w-full overflow-auto py-0"
    >
      <template #left>
        <div>
          <slot
            name="actions"
          />
          <v-alert
            v-if="error"
            v-shared-tooltip="error.message"
            type="error"
            dense
            class="overflow-hidden text-ellipsis whitespace-nowrap"
          >
            {{ error }}
          </v-alert>
        </div>
        <slot v-if="$slots.options" name="options" />
        <v-virtual-scroll
          v-else-if="items.length > 0"
          key="market-left"
          id="left-pane"
          :bench="16"
          class="visible-scroll h-full max-h-full w-full overflow-auto pl-1 pt-2"
          :items="items"
          :item-height="itemHeight"
          @scroll="onScroll"
        >
          <template #default="{ item, index }">
            <slot
              name="item"
              :item="item"
              :index="index"
              :has-update="typeof item === 'string' ? false : !!plans[item.id]"
              :checked="typeof item === 'string' ? false : (selections[item.id] || false)"
              :selection-mode="typeof item === 'string' ? false : (selectionMode && item.installed && item.installed.length > 0)"
              :selected="typeof item === 'string' ? false : ((selectedItem && (selectedItem.id === item.id) || selections[item.id]) || false)"
              :on="{
                // @ts-ignore
                click: (event) => onSelect(event, item)
              }"
            />
          </template>
        </v-virtual-scroll>
        <slot
          v-else
          class="responsive-container"
          name="placeholder"
        />
      </template>
      <template #right>
        <div
          key="market-right"
          id="right-pane"
          class="flex flex-col h-full flex-grow-0 overflow-y-auto overflow-x-hidden market-right"
        >
          <slot
            name="content"
            :selected-item="selectedItem"
            :selected-id="selectedId"
            :selected-modrinth-id="selectedModrinthId"
            :selected-curseforge-id="selectedCurseforgeId"
            :updating="plans[selectedItem?.id ?? '']?.updating"
          />
        </div>
      </template>
    </SplitPane>
    <slot />
  </div>
</template>

<script lang=ts setup>
import SplitPane from '@/components/SplitPane.vue'
import { kDialogModel } from '@/composables/dialog'
import { ProjectGroup } from '@/composables/modGroup'
import { UpgradePlan } from '@/composables/modUpgrade'
import { useQuery } from '@/composables/query'
import { vSharedTooltip } from '@/directives/sharedTooltip'
import { injection } from '@/util/inject'
import { ProjectEntry } from '@/util/search'

const props = defineProps<{
  plans: Record<string, UpgradePlan>
  items: (ProjectEntry | ProjectGroup | string)[]
  itemHeight: number
  selectionMode?: boolean
  loading?: boolean
  error?: any
}>()
const emit = defineEmits<{
  (event: 'load'): void
  (event: 'drop', e: DragEvent): void
  (event: 'update:selectionMode', v: boolean): void
}>()

const selectedId = useQuery('id')
const selectedItem = computed(() => {
  if (!selectedId.value) return undefined
  return props.items.find((i) => typeof i === 'object' && 'id' in i && i.id === selectedId.value) as ProjectEntry | undefined
})

watch(() => props.items, (i, old) => {
  if (!old || old.length === 0) {
    if (i.length > 0) {
      const first = i[0]
      if (typeof first === 'object' && 'id' in first) {
        selectedId.value = first.id
      }
    }
  }
})

const selectedModrinthId = computed(() => {
  const id = selectedId.value
  if (id && id?.startsWith('modrinth:')) {
    return id.substring('modrinth:'.length)
  }
  const item = selectedItem.value
  return item?.modrinthProjectId ||
    item?.modrinth?.project_id ||
    ''
})
const selectedCurseforgeId = computed(() => {
  const id = selectedId.value
  if (id && id?.startsWith('curseforge:')) {
    return Number(id.substring('curseforge:'.length))
  }
  return selectedItem.value?.curseforgeProjectId || selectedItem.value?.curseforge?.id || undefined
})

const onSelect = (event: MouseEvent, i: ProjectEntry) => {
  if (props.selectionMode && i.installed.length > 0) {
    // if ctrl is pressed
    if (event.ctrlKey) {
      selections.value = {
        ...selections.value,
        [i.id]: !selections.value[i.id],
      }
    } else if (event.shiftKey) {
      // Select all items between the last selected item and this item
      const list = props.items
      const lastIndex = list.findIndex((item) => typeof item === 'object' && 'id' in item && item.id === selectedId.value)
      const currentIndex = list.findIndex((item) => typeof item === 'object' && 'id' in item && item.id === i.id)
      const start = Math.min(lastIndex, currentIndex)
      const end = Math.max(lastIndex, currentIndex)
      const _selections: Record<string, boolean> = {}
      for (let i = start; i <= end; i++) {
        const item = list[i]
        if (typeof item === 'object' && 'id' in item) {
          _selections[item.id] = true
        }
      }
      selections.value = _selections
    } else {
      selectedId.value = i.id
      selections.value = {
        [i.id]: true,
      }
    }
  } else {
    selectedId.value = i.id
    selections.value = {}
  }
}

const onScroll = (e: Event) => {
  const target = e.target as HTMLElement
  if (!target) return
  if (target.scrollTop + target.clientHeight >= target.scrollHeight - 100) {
    emit('load')
  }
}

const selections = inject('selections', () => ref({} as Record<string, boolean>), true)
const { current } = injection(kDialogModel)
const onKeyPress = (e: KeyboardEvent) => {
  if (current.value.dialog) return
  // ctrl+a
  if (e.ctrlKey && e.key === 'a') {
    e.preventDefault()
    e.stopPropagation()
    emit('update:selectionMode', true)

    const _selections: Record<string, boolean> = {}
    for (const item of props.items) {
      if (typeof item === 'string' || !('id' in item)) continue
      if (item.installed.length > 0) {
        _selections[item.id] = true
      }
    }
    selections.value = _selections
  }
  // esc
  if (e.key === 'Escape') {
    emit('update:selectionMode', false)
    selections.value = {}
  }
}
onMounted(() => {
  document.addEventListener('keydown', onKeyPress)
})
onUnmounted(() => {
  document.removeEventListener('keydown', onKeyPress)
})

</script>

<style scoped>
.responsive-container {
  container-type: size;
  width: 100%;
}
</style>

<style>
.v-application .market-base .info {
  background-color: rgba(33, 150, 243, 0.8) !important;
  border-color: rgba(33, 150, 243, 0.8) !important;
}

.v-application .market-base .error {
  background-color: rgba(255, 82, 82, 0.8) !important;
  border-color: rgba(255, 82, 82, 0.8) !important;
}

.dark.v-application .market-base .info {
  background-color: rgba(33, 150, 243, 0.5) !important;
  border-color: rgba(33, 150, 243, 0.5) !important;
}

.dark.v-application .market-base .error {
  background-color: rgba(255, 82, 82, 0.5) !important;
  border-color: rgba(255, 82, 82, 0.5) !important;
}

.market-base .v-sheet.v-alert {
    margin: 4px 4px 4px 4px !important;
}

.market-base .v-virtual-scroll__item {
  left: 6px;
}

.dark .market-right {
  background-color: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(4px);
}
</style>
