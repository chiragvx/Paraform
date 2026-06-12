<script>
  // Single mount point for the secondary modal stack (library / diff /
  // custom-model). App.svelte renders <ExtraDialogs /> once at the top
  // level so any command or menu can flip the extras.* booleans without
  // wiring each component individually.
  import LibraryDialog from './LibraryDialog.svelte';
  import DiffViewer from './DiffViewer.svelte';
  import CustomModelDialog from './CustomModelDialog.svelte';
</script>

<LibraryDialog />
<DiffViewer />
<CustomModelDialog />
