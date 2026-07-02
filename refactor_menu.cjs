const fs = require('fs');
const path = require('path');

const filesToUpdate = [
    'src/App.vue',
    'src/components/FullContentBlock.vue',
    'src/views/menu/Menu_.vue',
    'src/views/menu/views/Menu_Chats.vue',
    'src/views/menu/views/Menu_Rooms.vue',
    'src/views/menu/views/Menu_Contacts.vue',
    'src/views/menu/views/Menu_Account.vue',
    'src/views/menu/views/Menu_Users.vue',
    'src/views/menu/views/Menu_Backup.vue',
    'src/components/modal/views/Modal_QrHandshake.vue'
];

for (const relPath of filesToUpdate) {
    const filePath = path.join(__dirname, relPath);
    if (!fs.existsSync(filePath)) continue;
    
    let content = fs.readFileSync(filePath, 'utf8');

    // Add import if not present
    if (content.includes('$menuOpened') && !content.includes('useMenu')) {
        const importStatement = `import { useMenu } from '@/composables/useMenu';\n`;
        content = content.replace(/<script setup>/g, `<script setup>\n${importStatement}`);
    }

    if (relPath === 'src/App.vue') {
        content = content.replace(/const \$menuOpened = ref\(true\);\nprovide\('\$menuOpened', \$menuOpened\);/g, 'const { isOpen: $menuOpened, open: openMenu, close: closeMenu } = useMenu();');
        content = content.replace(/@click="\$menuOpened = false"/g, '@click="closeMenu()"');
        content = content.replace(/\$menuOpened\.value = true/g, 'openMenu()');
    } else if (relPath === 'src/components/FullContentBlock.vue') {
        content = content.replace(/const \$menuOpened = inject\('\$menuOpened'\);/g, 'const { isOpen: $menuOpened, toggle: toggleMenu } = useMenu();');
        content = content.replace(/@click="\$menuOpened = !\$menuOpened"/g, '@click="toggleMenu()"');
    } else {
        content = content.replace(/const \$menuOpened = inject\('\$menuOpened'\);?/g, 'const { isOpen: $menuOpened, close: closeMenu } = useMenu();');
        content = content.replace(/\$menuOpened\.value = false;?/g, 'closeMenu();');
        content = content.replace(/@click="\$menuOpened = false"/g, '@click="closeMenu()"');
    }

    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Updated ${relPath}`);
}
